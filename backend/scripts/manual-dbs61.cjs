// Actual customer JWT/HTTP/PG workflow. All money enters through the operator deposit API.
process.env.NODE_ENV = 'test';
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  startPostgresContainer,
  stopPostgresContainer,
} = require('../test/support/postgres.container');
const { createTempDatabase, migrate } = require('../test/support/temp-database');
const { startDepositApp, seedDepositTarget } = require('../test/support/deposit-app');
const { checkLedgerInvariants } = require('../test/support/invariants');
const { validateEvent } = require('../src/common/events');

async function main() {
  console.log(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  let db, app;
  try {
    process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    const q = (sql, args = []) => db.runner.query(sql, args),
      operator = await app.issuer.token('operator', { sub: randomUUID() });
    async function http(path, body, jwt, key = randomUUID()) {
      const res = await fetch(app.url + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: JSON.stringify(body),
      });
      const output = {
        status: res.status,
        correlationId: res.headers.get('x-correlation-id'),
        contentType: res.headers.get('content-type'),
        body: await res.json(),
      };
      console.log(JSON.stringify({ method: 'POST', path, request: body, ...output }));
      return output;
    }
    const deposit = (to, amount) =>
      http('/v1/operator/deposits', { toAccountId: to, amount }, operator);
    const transfer = (a, to, amount = '300000', key = randomUUID()) =>
      http('/v1/transfers', { fromAccountId: a.accountId, toAccountId: to, amount }, a.token, key);
    async function target(amount = '0', status = 'ACTIVE') {
      const row = await seedDepositTarget(db.runner, status),
        token = await app.issuer.token('customer', { sub: row.sub });
      if (amount !== '0') assert.equal((await deposit(row.accountId, amount)).status, 201);
      return { ...row, token };
    }
    const balances = () => q('SELECT id,balance::text FROM accounts ORDER BY id');
    const snapshot = () =>
      q(
        `SELECT (SELECT count(*) FROM transfers)::int AS transfers,(SELECT count(*) FROM ledger_entries)::int AS lines,(SELECT count(*) FROM audit_log)::int AS audits,(SELECT count(*) FROM outbox_events)::int AS events,(SELECT count(*) FROM idempotency_keys)::int AS keys,(SELECT jsonb_object_agg(id,balance::text) FROM accounts) AS balances`,
      );
    async function invariant() {
      const report = await checkLedgerInvariants(db.runner);
      assert.equal(report.status, 'PASS');
      assert.equal(report.violations.length, 0);
      console.log(JSON.stringify({ ledgerInvariants: report }));
    }
    console.log(
      'SQL INPUT: users/customers/accounts at migration default ZERO, no SQL balance or ledger seed. ALL funding uses actual deposit HTTP.',
    );
    const a = await target('1000000'),
      b = await target();
    const first = await transfer(a, b.accountId),
      id = first.body.transferId;
    assert.equal(first.status, 201);
    const lines = await q(
      'SELECT account_id,direction,amount::text,balance_after::text FROM ledger_entries WHERE transfer_id=$1 ORDER BY direction',
      [id],
    );
    assert.deepEqual(lines, [
      { account_id: b.accountId, direction: 'CREDIT', amount: '300000', balance_after: '300000' },
      { account_id: a.accountId, direction: 'DEBIT', amount: '300000', balance_after: '700000' },
    ]);
    const [event] = await q('SELECT payload FROM outbox_events WHERE aggregate_id=$1', [id]);
    const [row] = await q('SELECT created_at FROM transfers WHERE id=$1', [id]);
    assert.equal(validateEvent(event.payload).ok, true);
    assert.equal(event.payload.occurredAt, row.created_at.toISOString());
    assert.equal(event.payload.fromBalanceBefore, '1000000');
    assert.equal(event.payload.fromUserId, a.userId);
    assert.equal(event.payload.toUserId, b.userId);
    assert.equal(event.payload.sameOwner, false);
    for (const [table, column] of [
      ['audit_log', 'target_id'],
      ['outbox_events', 'aggregate_id'],
      ['idempotency_keys', 'transfer_id'],
    ])
      assert.deepEqual(
        await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [id]),
        [{ n: 1 }],
      );
    const actual = await balances();
    assert.equal(actual.find(r => r.id === a.accountId).balance, '700000');
    assert.equal(actual.find(r => r.id === b.accountId).balance, '300000');
    console.log(
      JSON.stringify({
        actualLedgerLines: lines,
        actualBalances: actual,
        actualEvent: event.payload,
      }),
    );
    await invariant();
    console.log(
      'M-61-01 PASS: AC5.1 transfer300000, A700000/B300000, exact two lines, audit1/outbox1/key1, DB snapshot event valid',
    );

    const poor = await target('100000'),
      locked = await target('0', 'LOCKED');
    for (const [src, to, code] of [
      [poor, b.accountId, 'INSUFFICIENT_FUNDS'],
      [a, locked.accountId, 'ACCOUNT_NOT_ACTIVE'],
    ]) {
      const before = await snapshot(),
        res = await transfer(src, to);
      assert.equal(res.status, 422);
      assert.equal(res.body.errorCode, code);
      assert.ok(res.contentType.includes('application/problem+json'));
      assert.deepEqual(await snapshot(), [
        {
          ...before[0],
          transfers: before[0].transfers + 1,
          audits: before[0].audits + 1,
          keys: before[0].keys + 1,
        },
      ]);
      const rows = await q('SELECT status,reject_reason FROM transfers WHERE id=$1', [
        res.body.transferId,
      ]);
      assert.deepEqual(rows, [{ status: 'REJECTED', reject_reason: code }]);
      console.log(JSON.stringify({ persistedRejection: rows }));
    }
    const beforeDenied = await snapshot(),
      denied = await http(
        '/v1/transfers',
        { fromAccountId: b.accountId, toAccountId: a.accountId, amount: '1' },
        a.token,
      );
    assert.equal(denied.status, 404);
    assert.deepEqual(await snapshot(), [
      { ...beforeDenied[0], audits: beforeDenied[0].audits + 1 },
    ]);
    const audits = await q(
      "SELECT actor_user_id,outcome,metadata,correlation_id FROM audit_log WHERE target_id=$1 AND outcome='DENIED'",
      [b.accountId],
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_user_id, a.userId);
    console.log(JSON.stringify({ actualDeniedAudit: audits }));
    await invariant();
    console.log(
      'M-61-02 PASS: AC5.2 persisted422 without money; locked422; foreign source404 and DENIED',
    );

    const body = { fromAccountId: a.accountId, toAccountId: b.accountId, amount: '1000' };
    assert.equal(
      (await http('/v1/transfers', body, a.token, null)).body.errorCode,
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    assert.equal((await http('/v1/transfers', body, operator)).body.errorCode, 'FORBIDDEN');
    const key = randomUUID();
    assert.equal((await transfer(a, b.accountId, '1000', key)).status, 201);
    const duplicateBefore = await snapshot();
    assert.equal((await transfer(a, b.accountId, '1000', key)).status, 409);
    assert.deepEqual(await snapshot(), duplicateBefore);
    await invariant();
    console.log(
      'M-61-03 PASS: missingkey400/wrongrole403; duplicate409 no extra writes (full replay deferred79)',
    );

    for (const table of ['audit_log', 'outbox_events']) {
      const retryKey = randomUUID(),
        before = await snapshot();
      await q(
        "CREATE FUNCTION dbs61_manual_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture unavailable'; END $$",
      );
      await q(
        `CREATE TRIGGER dbs61_manual_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION dbs61_manual_fail()`,
      );
      try {
        const failed = await transfer(a, b.accountId, '1000', retryKey);
        assert.equal(failed.status, 500);
        assert.equal(failed.body.detail, 'Internal server error');
        assert.deepEqual(await snapshot(), before);
      } finally {
        await q(`DROP TRIGGER dbs61_manual_fail ON ${table}`);
        await q('DROP FUNCTION dbs61_manual_fail()');
      }
      assert.equal((await transfer(a, b.accountId, '1000', retryKey)).status, 201);
      console.log(JSON.stringify({ recoveredWrite: table, sameKeyRetry: 201 }));
    }
    await invariant();
    console.log(
      'M-61-04 PASS: real audit/outbox500 rolls back all rows/balances/key; same-key retry201',
    );

    const c = await target('1000000'),
      d = await target();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => transfer(c, d.accountId, '200000')),
    );
    const counts = {
      completed: results.filter(r => r.status === 201).length,
      rejected: results.filter(r => r.status === 422 && r.body.errorCode === 'INSUFFICIENT_FUNDS')
        .length,
    };
    assert.deepEqual(counts, { completed: 5, rejected: 5 });
    const after = await balances();
    assert.equal(after.find(r => r.id === c.accountId).balance, '0');
    assert.equal(after.find(r => r.id === d.accountId).balance, '1000000');
    console.log(JSON.stringify({ concurrentWithdrawals: counts }));
    const amount = '9007199254740993',
      big = await target(amount),
      recipient = await target();
    const large = await transfer(big, recipient.accountId, amount);
    assert.equal(large.status, 201);
    const [bigBalance] = await q('SELECT balance::text FROM accounts WHERE id=$1', [
      recipient.accountId,
    ]);
    assert.equal(bigBalance.balance, amount);
    const [bigEvent] = await q('SELECT payload FROM outbox_events WHERE aggregate_id=$1', [
      large.body.transferId,
    ]);
    assert.equal(bigEvent.payload.amount, amount);
    assert.equal(validateEvent(bigEvent.payload).ok, true);
    console.log(
      JSON.stringify({
        largeAmountStored: bigBalance.balance,
        eventAmount: bigEvent.payload.amount,
      }),
    );
    await invariant();
    console.log(
      'M-61-05 PASS:10parallel200k →5complete5reject, no overdraft; >2^53 exact API/DB/event',
    );
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await db?.drop();
      } finally {
        await stopPostgresContainer();
      }
    }
    console.log('M-61-06 PASS: app/publicJWKS/owned temporary DB/owned PG17 cleaned up');
  }
}
main().catch(error => {
  console.error(error.name + ': ' + error.message);
  process.exitCode = 1;
});
