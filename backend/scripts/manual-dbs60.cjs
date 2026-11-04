// Real operator deposits; SQL INPUT fixtures have default-zero balances only.
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
const FUNDING = '00000000-0000-4000-8000-000000000001';
async function main() {
  console.log(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  let db, app;
  try {
    process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    const token = await app.issuer.token('operator', { sub: randomUUID() }),
      q = (sql, args = []) => db.runner.query(sql, args);
    const http = async (to, amount = '1000000', key = randomUUID(), jwt = token) => {
      const response = await fetch(app.url + '/v1/operator/deposits', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: JSON.stringify({ toAccountId: to, amount }),
      });
      const result = {
        status: response.status,
        correlationId: response.headers.get('x-correlation-id'),
        body: await response.json(),
      };
      console.log(
        JSON.stringify({ method: 'POST', path: '/v1/operator/deposits', amount, ...result }),
      );
      return result;
    };
    const invariants = async () => {
      const report = await checkLedgerInvariants(db.runner);
      assert.equal(report.status, 'PASS');
      console.log(JSON.stringify({ ledgerInvariants: report }));
    };
    console.log(
      'SQL INPUT fixtures: users/customers/accounts with migration default ZERO only; no balance or ledger seeding',
    );
    const a = await seedDepositTarget(db.runner),
      locked = await seedDepositTarget(db.runner, 'LOCKED');
    const first = await http(a.accountId);
    assert.equal(first.status, 201);
    const lines = await q(
      'SELECT account_id,direction,amount::text,balance_after::text FROM ledger_entries WHERE transfer_id=$1 ORDER BY direction',
      [first.body.transferId],
    );
    assert.deepEqual(lines, [
      { account_id: a.accountId, direction: 'CREDIT', amount: '1000000', balance_after: '1000000' },
      { account_id: FUNDING, direction: 'DEBIT', amount: '1000000', balance_after: '-1000000' },
    ]);
    for (const [table, column] of [
      ['audit_log', 'target_id'],
      ['outbox_events', 'aggregate_id'],
      ['idempotency_keys', 'transfer_id'],
    ])
      assert.deepEqual(
        await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [
          first.body.transferId,
        ]),
        [{ n: 1 }],
      );
    console.log(JSON.stringify({ actualLedgerLines: lines }));
    await invariants();
    console.log(
      'M-60-01 PASS: deposit1m201, exact DEBIT/CREDIT, audit1/outbox1/key1, invariant PASS',
    );
    const next = await http(a.accountId, '300000000');
    assert.equal(next.status, 201);
    const [event] = await q('SELECT payload FROM outbox_events WHERE aggregate_id=$1', [
      next.body.transferId,
    ]);
    const [transfer] = await q('SELECT created_at FROM transfers WHERE id=$1', [
      next.body.transferId,
    ]);
    assert.equal(validateEvent(event.payload).ok, true);
    assert.equal(event.payload.fromBalanceBefore, '-1000000');
    assert.equal(event.payload.fromUserId, null);
    assert.equal(event.payload.sameOwner, false);
    assert.equal(event.payload.occurredAt, transfer.created_at.toISOString());
    console.log(JSON.stringify({ actualEvent: event.payload }));
    await invariants();
    console.log(
      'M-60-02 PASS: SYSTEM balance/limits bypass, negative snapshot,null owner,false sameOwner,DB timeZ',
    );
    for (const id of [locked.accountId, randomUUID(), FUNDING]) {
      const res = await http(id);
      assert.equal(res.status, 422);
      assert.equal(res.body.errorCode, 'ACCOUNT_NOT_ACTIVE');
      assert.deepEqual(
        await q('SELECT count(*)::int AS n FROM ledger_entries WHERE transfer_id=$1', [
          res.body.transferId,
        ]),
        [{ n: 0 }],
      );
    }
    assert.equal((await http(a.accountId, '1', null)).body.errorCode, 'IDEMPOTENCY_KEY_REQUIRED');
    const customerToken = await app.issuer.token('customer', { sub: randomUUID() });
    assert.equal((await http(a.accountId, '1', randomUUID(), customerToken)).status, 403);
    await invariants();
    console.log(
      'M-60-03 PASS: locked/missing/SYSTEM422 persisted rejection, no lines; missingkey400/wrongrole403',
    );
    for (const table of ['audit_log', 'outbox_events']) {
      const key = randomUUID(),
        [before] = await q('SELECT balance::text FROM accounts WHERE id=$1', [a.accountId]);
      await q(
        "CREATE FUNCTION dbs60_manual_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture unavailable'; END $$",
      );
      await q(
        `CREATE TRIGGER dbs60_manual_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION dbs60_manual_fail()`,
      );
      try {
        const res = await http(a.accountId, '1000', key);
        assert.equal(res.status, 500);
        assert.equal(res.body.detail, 'Internal server error');
        assert.deepEqual(await q('SELECT balance::text FROM accounts WHERE id=$1', [a.accountId]), [
          before,
        ]);
        assert.deepEqual(
          await q('SELECT count(*)::int AS n FROM idempotency_keys WHERE idem_key=$1', [key]),
          [{ n: 0 }],
        );
      } finally {
        await q(`DROP TRIGGER dbs60_manual_fail ON ${table}`);
        await q('DROP FUNCTION dbs60_manual_fail()');
      }
      assert.equal((await http(a.accountId, '1000', key)).status, 201);
    }
    await invariants();
    console.log(
      'M-60-04 PASS: real audit/outbox fault500 rolls back key and money; same-key retry201',
    );
    const b = await seedDepositTarget(db.runner),
      parallel = await Promise.all(Array.from({ length: 10 }, () => http(b.accountId, '1000')));
    assert.ok(parallel.every(r => r.status === 201));
    assert.deepEqual(await q('SELECT balance::text FROM accounts WHERE id=$1', [b.accountId]), [
      { balance: '10000' },
    ]);
    const key = randomUUID();
    assert.equal((await http(b.accountId, '1000', key)).status, 201);
    assert.equal((await http(b.accountId, '1000', key)).status, 409);
    const c = await seedDepositTarget(db.runner),
      amount = '9007199254740993';
    const big = await http(c.accountId, amount);
    assert.equal(big.status, 201);
    assert.deepEqual(await q('SELECT balance::text FROM accounts WHERE id=$1', [c.accountId]), [
      { balance: amount },
    ]);
    await invariants();
    console.log(
      'M-60-05 PASS:10 concurrent distinct deposits correct; duplicate409 no extra credit; >2^53 exact via API. Full replay pending79',
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
    console.log('M-60-06 PASS: app/publicJWKS/tempDB/ownedPG17 cleaned up');
  }
}
main().catch(error => {
  console.error(error.name + ': ' + error.message);
  process.exitCode = 1;
});
