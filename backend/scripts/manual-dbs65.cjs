// Run directly from backend/. Private containers; all customer/account/money input goes through HTTP.
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
const { startValkeyContainer } = require('../test/support/valkey.container');
const { createTempDatabase, migrate } = require('../test/support/temp-database');
const { startDepositApp } = require('../test/support/deposit-app');
const { checkLedgerInvariants } = require('../test/support/invariants');
const { validateEvent } = require('../src/common/events');

const FUNDING = '00000000-0000-4000-8000-000000000001';
const pass = (step, message) => console.log(`${step} PASS ${message}`);

async function main() {
  console.log(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  console.log(
    JSON.stringify({
      runtime: process.version,
      environment: 'LOCAL PostgreSQL17/Valkey8 Testcontainers',
      authentication: 'real local RS256 JWT',
      defaults: '50m/tx,200m/day,10transfers/min,100requests/IP/min',
      cloud: 'NOT RUN',
    }),
  );
  const previousUrl = process.env.DATABASE_URL;
  let db, app, valkey;
  try {
    process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
    valkey = await startValkeyContainer();
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, { rateLimit: { redisUrl: valkey.url } });
    const q = (sql, args = []) => db.runner.query(sql, args);
    const inspect = async (sql, params = []) => {
      const rows = await q(sql, params);
      console.log(JSON.stringify({ sql, params, rows }));
      return rows;
    };
    async function http(method, path, token, body, key) {
      const response = await fetch(app.url + path, {
        method,
        signal: AbortSignal.timeout(15000),
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = {
        status: response.status,
        correlationId: response.headers.get('x-correlation-id'),
        contentType: response.headers.get('content-type'),
        body: await response.json(),
      };
      const safeBody = { ...result.body };
      if ('fullName' in safeBody) safeBody.fullName = '[REDACTED]';
      console.log(
        JSON.stringify({
          method,
          path,
          ...(key ? { idempotencyKey: key } : {}),
          ...(body
            ? { request: { ...body, ...(body.fullName ? { fullName: '[REDACTED]' } : {}) } }
            : {}),
          ...result,
          body: Array.isArray(result.body) ? result.body : safeBody,
        }),
      );
      assert.match(result.correlationId, /^[0-9a-f-]{36}$/);
      return result;
    }
    async function audit(res, actor, role, action, outcome, targetType, targetId) {
      const rows = await inspect(
        'SELECT actor_user_id,actor_role,action,outcome,target_type,target_id,correlation_id FROM audit_log WHERE correlation_id=$1',
        [res.correlationId],
      );
      assert.deepEqual(rows, [
        {
          actor_user_id: actor,
          actor_role: role,
          action,
          outcome,
          target_type: targetType,
          target_id: targetId,
          correlation_id: res.correlationId,
        },
      ]);
    }
    async function customer(name) {
      const sub = randomUUID(),
        token = await app.issuer.token('customer', { sub });
      const profile = await http('POST', '/v1/customers/me', token, { fullName: name });
      assert.equal(profile.status, 200);
      const [user] = await q('SELECT id FROM users WHERE cognito_sub=$1', [sub]);
      await audit(
        profile,
        user.id,
        'customer',
        'customer.created',
        'SUCCESS',
        'customer',
        profile.body.id,
      );
      const opened = await http('POST', '/v1/accounts', token, { type: 'CHECKING' });
      assert.equal(opened.status, 201);
      assert.equal(opened.body.balance, '0');
      assert.equal(opened.body.status, 'ACTIVE');
      await audit(
        opened,
        user.id,
        'customer',
        'account.open',
        'SUCCESS',
        'account',
        opened.body.id,
      );
      return { token, userId: user.id, accountId: opened.body.id };
    }
    async function balances(a, b, expected) {
      for (const [i, owner] of [a, b].entries()) {
        const list = await http('GET', '/v1/accounts', owner.token);
        const detail = await http('GET', '/v1/accounts/' + owner.accountId, owner.token);
        assert.equal(list.status, 200);
        assert.equal(detail.status, 200);
        assert.deepEqual(list.body, [detail.body]);
        assert.equal(detail.body.id, owner.accountId);
        assert.equal(detail.body.balance, expected[i]);
        assert.deepEqual(
          Object.keys(detail.body).sort(),
          ['id', 'type', 'status', 'balance', 'createdAt', 'updatedAt'].sort(),
        );
        await audit(
          list,
          owner.userId,
          'customer',
          'account.list',
          'SUCCESS',
          'user',
          owner.userId,
        );
        await audit(
          detail,
          owner.userId,
          'customer',
          'account.read',
          'SUCCESS',
          'account',
          owner.accountId,
        );
      }
    }
    const snapshot = async () =>
      (
        await q(`SELECT (SELECT count(*)::int FROM transfers) AS transfers,
      (SELECT count(*)::int FROM ledger_entries) AS lines,(SELECT count(*)::int FROM audit_log) AS audits,
      (SELECT count(*)::int FROM outbox_events) AS events,(SELECT count(*)::int FROM idempotency_keys) AS keys,
      (SELECT jsonb_object_agg(id,balance::text) FROM accounts) AS balances`)
      )[0];

    const a = await customer('Nguyễn Minh Anh'),
      b = await customer('Trần Thu Hà');
    assert.notEqual(a.userId, b.userId);
    assert.notEqual(a.accountId, b.accountId);
    pass('M-65-01', 'onboarding and opening over HTTP, zero ACTIVE accounts, committed audit');

    const operatorSub = randomUUID(),
      operator = await app.issuer.token('operator', { sub: operatorSub });
    const depositKey = randomUUID(),
      depositBody = { toAccountId: a.accountId, amount: '1000000' };
    const deposited = await http(
      'POST',
      '/v1/operator/deposits',
      operator,
      depositBody,
      depositKey,
    );
    assert.equal(deposited.status, 201);
    assert.equal(deposited.body.status, 'COMPLETED');
    const [operatorUser] = await q('SELECT id FROM users WHERE cognito_sub=$1', [operatorSub]);
    await audit(
      deposited,
      operatorUser.id,
      'operator',
      'deposit',
      'SUCCESS',
      'transfer',
      deposited.body.transferId,
    );
    await balances(a, b, ['1000000', '0']);
    pass('M-65-02', 'operator deposited 1000000; A1000000/B0');

    const transferKey = randomUUID(),
      body = { fromAccountId: a.accountId, toAccountId: b.accountId, amount: '300000' };
    const transferred = await http('POST', '/v1/transfers', a.token, body, transferKey);
    assert.equal(transferred.status, 201);
    assert.equal(transferred.body.status, 'COMPLETED');
    await audit(
      transferred,
      a.userId,
      'customer',
      'transfer',
      'SUCCESS',
      'transfer',
      transferred.body.transferId,
    );
    await balances(a, b, ['700000', '300000']);
    const movements = await inspect(
      'SELECT id,type,amount::text,status,initiated_by,correlation_id,created_at FROM transfers ORDER BY created_at',
    );
    assert.equal(movements.length, 2);
    const entries = await inspect(
      'SELECT transfer_id,account_id,direction,amount::text,balance_after::text FROM ledger_entries ORDER BY transfer_id,direction',
    );
    for (const [id, debitAccount, creditAccount, amount, debitAfter, creditAfter] of [
      [deposited.body.transferId, FUNDING, a.accountId, '1000000', '-1000000', '1000000'],
      [transferred.body.transferId, a.accountId, b.accountId, '300000', '700000', '300000'],
    ]) {
      assert.deepEqual(
        entries.filter(e => e.transfer_id === id),
        [
          {
            transfer_id: id,
            account_id: creditAccount,
            direction: 'CREDIT',
            amount,
            balance_after: creditAfter,
          },
          {
            transfer_id: id,
            account_id: debitAccount,
            direction: 'DEBIT',
            amount,
            balance_after: debitAfter,
          },
        ],
      );
    }
    const events = await inspect(
      'SELECT event_id,event_type,aggregate_id,payload,correlation_id,published_at FROM outbox_events ORDER BY id',
    );
    assert.equal(events.length, 2);
    for (const [i, event] of events.entries()) {
      const row = movements.find(m => m.id === event.aggregate_id);
      assert.equal(validateEvent(event.payload).ok, true);
      assert.equal(event.event_type, 'TransferCompleted');
      assert.equal(event.published_at, null);
      assert.equal(event.correlation_id, row.correlation_id);
      const dates = await q('SELECT id,created_at FROM accounts WHERE id=ANY($1::uuid[])', [
        [i === 0 ? FUNDING : a.accountId, i === 0 ? a.accountId : b.accountId],
      ]);
      const from = i === 0 ? FUNDING : a.accountId,
        to = i === 0 ? a.accountId : b.accountId;
      assert.deepEqual(event.payload, {
        eventId: event.event_id,
        eventType: 'TransferCompleted',
        transferId: row.id,
        type: i === 0 ? 'DEPOSIT' : 'TRANSFER',
        occurredAt: row.created_at.toISOString(),
        correlationId: row.correlation_id,
        amount: i === 0 ? '1000000' : '300000',
        fromBalanceBefore: i === 0 ? '0' : '1000000',
        fromAccountId: from,
        toAccountId: to,
        fromAccountCreatedAt: dates.find(d => d.id === from).created_at.toISOString(),
        toAccountCreatedAt: dates.find(d => d.id === to).created_at.toISOString(),
        fromUserId: i === 0 ? null : a.userId,
        toUserId: i === 0 ? a.userId : b.userId,
        sameOwner: false,
      });
    }
    pass(
      'M-65-03',
      'A700000/B300000; four exact entries, two audited transfers and two validated outbox events',
    );

    const beforeReplay = await snapshot();
    assert.deepEqual(
      (await http('POST', '/v1/operator/deposits', operator, depositBody, depositKey)).body,
      deposited.body,
    );
    assert.deepEqual(
      (await http('POST', '/v1/transfers', a.token, body, transferKey)).body,
      transferred.body,
    );
    assert.deepEqual(await snapshot(), beforeReplay);
    const rejectKey = randomUUID(),
      rejectBody = { ...body, amount: '800000' };
    const rejected = await http('POST', '/v1/transfers', a.token, rejectBody, rejectKey);
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.errorCode, 'INSUFFICIENT_FUNDS');
    await audit(
      rejected,
      a.userId,
      'customer',
      'transfer',
      'REJECTED',
      'transfer',
      rejected.body.transferId,
    );
    const rejectionRows = await inspect('SELECT status,reject_reason FROM transfers WHERE id=$1', [
      rejected.body.transferId,
    ]);
    assert.deepEqual(rejectionRows, [{ status: 'REJECTED', reject_reason: 'INSUFFICIENT_FUNDS' }]);
    assert.deepEqual(
      await inspect('SELECT id FROM ledger_entries WHERE transfer_id=$1', [
        rejected.body.transferId,
      ]),
      [],
    );
    assert.deepEqual(
      await inspect('SELECT id FROM outbox_events WHERE aggregate_id=$1', [
        rejected.body.transferId,
      ]),
      [],
    );
    const afterReject = await snapshot();
    assert.deepEqual(afterReject, {
      ...beforeReplay,
      transfers: 3,
      keys: 3,
      audits: beforeReplay.audits + 1,
    });
    const replayReject = await http('POST', '/v1/transfers', a.token, rejectBody, rejectKey);
    assert.equal(replayReject.status, 422);
    assert.equal(replayReject.body.transferId, rejected.body.transferId);
    assert.equal(replayReject.body.errorCode, 'INSUFFICIENT_FUNDS');
    assert.deepEqual(await snapshot(), afterReject);
    pass(
      'M-65-04',
      'success/rejection replay caused no duplicate effects; manual700000→800000 rejection variant',
    );

    const beforeDenial = await snapshot();
    const forbiddenRead = await http('GET', '/v1/accounts/' + b.accountId, a.token);
    assert.equal(forbiddenRead.status, 404);
    assert.equal('balance' in forbiddenRead.body, false);
    await audit(
      forbiddenRead,
      a.userId,
      'customer',
      'account.read',
      'DENIED',
      'account',
      b.accountId,
    );
    const forbiddenSource = await http(
      'POST',
      '/v1/transfers',
      a.token,
      { fromAccountId: b.accountId, toAccountId: a.accountId, amount: '100000' },
      randomUUID(),
    );
    assert.equal(forbiddenSource.status, 404);
    await audit(
      forbiddenSource,
      a.userId,
      'customer',
      'ledger.transfer',
      'DENIED',
      'account',
      b.accountId,
    );
    const forbiddenDeposit = await http(
      'POST',
      '/v1/operator/deposits',
      a.token,
      depositBody,
      randomUUID(),
    );
    assert.equal(forbiddenDeposit.status, 403);
    assert.equal(forbiddenDeposit.body.errorCode, 'FORBIDDEN');
    assert.deepEqual(await snapshot(), { ...beforeDenial, audits: beforeDenial.audits + 2 });
    console.log('KNOWN GAP BL-132: wrong role logs a refusal; no audit_log DENIED is claimed.');
    pass('M-65-05', 'foreign resource404 + DENIED, wrong role403; no money effects');

    await balances(a, b, ['700000', '300000']);
    const final = await snapshot();
    assert.equal(final.balances[FUNDING], '-1000000');
    assert.deepEqual([final.transfers, final.lines, final.keys, final.events], [3, 4, 3, 2]);
    await inspect(
      'SELECT user_id,idem_key,response_code,transfer_id FROM idempotency_keys ORDER BY created_at',
    );
    const report = await checkLedgerInvariants(db.runner);
    console.log(JSON.stringify({ invariantSql: 'test/support/invariants.sql', report, final }));
    assert.deepEqual(report, {
      status: 'PASS',
      totals: { debit: '1300000', credit: '1300000', balance: '0' },
      violations: [],
    });
    pass('M-65-06', 'five invariants PASS; zero violations; final rows checked');
  } finally {
    const failures = [];
    for (const clean of [
      () => app?.close(),
      () => db?.drop(),
      () => valkey?.stop(),
      () => stopPostgresContainer(),
    ]) {
      try {
        await clean();
      } catch {
        failures.push('cleanup failure');
      }
    }
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (failures.length) throw new Error('Cleanup failed');
    console.log('CLEANUP PASS: closed app and removed only owned database/containers.');
  }
}
main().catch(error => {
  // Assertion messages may contain actual values: publish a fixed failure and safe code only.
  console.error(
    JSON.stringify({
      result: 'FAIL',
      type: error instanceof assert.AssertionError ? 'AssertionError' : 'RuntimeError',
      code:
        typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
          ? error.code
          : 'MANUAL_FAILURE',
    }),
  );
  process.exitCode = 1;
});
