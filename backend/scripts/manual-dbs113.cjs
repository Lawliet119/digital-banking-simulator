// DBS-113 manual test: operator locks and unlocks customer accounts (UC-11, FR-ACC-03, FR-ID-05,
// BR-12, BR-13) on the real NestJS app with real JWTs and PostgreSQL 17 in a Testcontainers
// container. Money enters only through POST /v1/operator/deposits; no token or Authorization
// header is ever printed.
const path = require('node:path');
const { createHash } = require('node:crypto');

process.env.TS_NODE_PROJECT ??= path.resolve(__dirname, '../tsconfig.json');
process.chdir(path.resolve(__dirname, '..'));

const { runManual } = require('./lib/ledger-manual-harness.cjs');

const FUNDING = '00000000-0000-4000-8000-000000000001';

function fp(reason) {
  return createHash('sha256')
    .update(reason.normalize('NFC').trim(), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

runManual('DBS-113', async ctx => {
  const { q, app, target, http, balance, invariant, operator, assert, pass, randomUUID } = ctx;

  const getJson = async (urlPath, jwt) => {
    const res = await fetch(app.url + urlPath, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = await res.json();
    console.log(
      JSON.stringify({
        method: 'GET',
        path: urlPath,
        status: res.status,
        correlationId: res.headers.get('x-correlation-id'),
        body,
      }),
    );
    return { status: res.status, body };
  };

  const lock = (accountId, body, jwt = operator) =>
    http(`/v1/operator/accounts/${accountId}/lock`, body, jwt, null);

  const unlock = (accountId, body, jwt = operator) =>
    http(`/v1/operator/accounts/${accountId}/unlock`, body, jwt, null);

  const named = async (name, amount = '0', status = 'ACTIVE') => {
    const row = await target(amount, status);
    await q('UPDATE customers SET full_name = $2 WHERE id = $1', [row.customerId, name]);
    return row;
  };

  // M-113-01: Create Nguyễn Minh Anh (2,000,000 VND via deposit API) and Trần Thu Hà (1,000,000 VND via deposit API).
  // Operator locks Minh Anh's account with reason CONFIRMED_FRAUD.
  const minhAnh = await named('Nguyễn Minh Anh', '2000000');
  const thuHa = await named('Trần Thu Hà', '1000000');

  const lockRes = await lock(minhAnh.accountId, { reason: 'CONFIRMED_FRAUD' });
  assert.equal(lockRes.status, 200);
  assert.deepEqual(Object.keys(lockRes.body).sort(), ['id', 'status', 'type', 'updatedAt']);
  assert.equal(lockRes.body.id, minhAnh.accountId);
  assert.equal(lockRes.body.status, 'LOCKED');
  assert.ok(!/balance|2000000|reason|CONFIRMED_FRAUD/i.test(JSON.stringify(lockRes.body)));

  const [acc1] = await q('SELECT status FROM accounts WHERE id = $1', [minhAnh.accountId]);
  const [user1] = await q('SELECT sessions_revoked_at FROM users WHERE id = $1', [minhAnh.userId]);
  const [audit1] = await q(
    'SELECT action, outcome, target_type, target_id, metadata FROM audit_log WHERE correlation_id = $1',
    [lockRes.correlationId],
  );
  const [outbox1] = await q(
    "SELECT event_type, aggregate_id, payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AccountStatusChanged'",
    [minhAnh.accountId],
  );
  console.log(JSON.stringify({ m113_01_db: { acc1, audit1, outbox1 } }));
  assert.equal(acc1.status, 'LOCKED');
  assert.ok(user1.sessions_revoked_at instanceof Date);
  assert.deepEqual(audit1.metadata, { id: fp('CONFIRMED_FRAUD'), reason: 'CONFIRMED_FRAUD' });
  assert.equal(outbox1.payload.newStatus, 'LOCKED');
  assert.ok(!('reason' in outbox1.payload));
  pass(
    'M-113-01',
    'POST /v1/operator/accounts/{id}/lock -> 200 LOCKED (no balance); status, sessions_revoked_at, audit_log, and AccountStatusChanged outbox committed in one transaction',
  );

  // M-113-02: Minh Anh uses her pre-lock token (iat == revokedSec) -> 401 SESSION_REVOKED
  const revokedSec = Math.floor(user1.sessions_revoked_at.getTime() / 1000);
  const preLockToken = await app.issuer.token('customer', { sub: minhAnh.sub, iat: revokedSec });
  const revokedCall = await getJson('/v1/accounts', preLockToken);
  assert.equal(revokedCall.status, 401);
  assert.equal(revokedCall.body.errorCode, 'SESSION_REVOKED');
  pass(
    'M-113-02',
    'Minh Anh pre-lock token (iat == sessions_revoked_at) is immediately rejected with 401 SESSION_REVOKED (AC-11.1)',
  );

  // M-113-03: Trần Thu Hà transfers 300,000 VND to Minh Anh's LOCKED account; Minh Anh re-logins (iat = revokedSec + 1)
  // and tries to transfer 100,000 VND from her LOCKED account -> both 422 ACCOUNT_NOT_ACTIVE, no lock reason leaked (AC-11.2, BR-13)
  const freshHaToken = await app.issuer.token('customer', { sub: thuHa.sub, iat: revokedSec + 1 });
  const freshMinhAnhToken = await app.issuer.token('customer', {
    sub: minhAnh.sub,
    iat: revokedSec + 1,
  });

  const haToLocked = await http(
    '/v1/transfers',
    { fromAccountId: thuHa.accountId, toAccountId: minhAnh.accountId, amount: '300000' },
    freshHaToken,
  );
  assert.equal(haToLocked.status, 422);
  assert.equal(haToLocked.body.errorCode, 'ACCOUNT_NOT_ACTIVE');

  const lockedToHa = await http(
    '/v1/transfers',
    { fromAccountId: minhAnh.accountId, toAccountId: thuHa.accountId, amount: '100000' },
    freshMinhAnhToken,
  );
  assert.equal(lockedToHa.status, 422);
  assert.equal(lockedToHa.body.errorCode, 'ACCOUNT_NOT_ACTIVE');
  assert.equal(await balance(minhAnh.accountId), '2000000');

  const custAccounts = await getJson('/v1/accounts', freshMinhAnhToken);
  const custTransfer = await getJson(
    `/v1/transfers/${lockedToHa.body.transferId}`,
    freshMinhAnhToken,
  );
  const customerVisible = JSON.stringify({
    haToLocked: haToLocked.body,
    lockedToHa: lockedToHa.body,
    custAccounts: custAccounts.body,
    custTransfer: custTransfer.body,
  });
  assert.ok(!/CONFIRMED_FRAUD|OPERATOR_LOCK/i.test(customerVisible));
  assert.ok(!customerVisible.includes(fp('CONFIRMED_FRAUD')));
  pass(
    'M-113-03',
    'Transfers to and from the LOCKED account return 422 ACCOUNT_NOT_ACTIVE (persisted REJECTED), balance stays 2,000,000, and customer responses never expose the lock reason (AC-11.2, BR-13)',
  );

  // M-113-04: Repeat /lock on already-LOCKED account (idempotent), role checks (customer, auditor -> 403), invalid reason -> 400, funding -> 404
  const secondLock = await lock(minhAnh.accountId, { reason: 'COMPLIANCE_HOLD' });
  assert.equal(secondLock.status, 200);
  assert.equal(secondLock.body.status, 'LOCKED');
  const [{ n: outboxCountAfterRepeat }] = await q(
    "SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AccountStatusChanged'",
    [minhAnh.accountId],
  );
  const [{ n: auditCountAfterRepeat }] = await q(
    "SELECT count(*)::int AS n FROM audit_log WHERE target_type = 'account' AND target_id = $1 AND action = 'account.lock'",
    [minhAnh.accountId],
  );
  assert.equal(outboxCountAfterRepeat, 1);
  assert.equal(auditCountAfterRepeat, 2);

  const auditorToken = await app.issuer.token('auditor', { sub: randomUUID() });
  assert.equal(
    (await lock(minhAnh.accountId, { reason: 'CONFIRMED_FRAUD' }, freshMinhAnhToken)).status,
    403,
  );
  assert.equal(
    (await lock(minhAnh.accountId, { reason: 'CONFIRMED_FRAUD' }, auditorToken)).status,
    403,
  );
  assert.equal((await lock(minhAnh.accountId, { reason: '   ' })).status, 400);
  assert.equal((await lock(FUNDING, { reason: 'CONFIRMED_FRAUD' })).status, 404);
  pass(
    'M-113-04',
    'Repeat /lock is idempotent (1 outbox event, 2 audit rows); customer/auditor get 403 FORBIDDEN; blank reason gets 400; SYSTEM funding account gets 404',
  );

  // M-113-05: Operator unlocks Minh Anh's account; Minh Anh transfers 300,000 VND to Trần Thu Hà -> 201 COMPLETED
  const unlockRes = await unlock(minhAnh.accountId, {
    reason: 'Đã xác minh chính chủ tại quầy giao dịch',
  });
  assert.equal(unlockRes.status, 200);
  assert.equal(unlockRes.body.status, 'ACTIVE');

  const transferAfterUnlock = await http(
    '/v1/transfers',
    { fromAccountId: minhAnh.accountId, toAccountId: thuHa.accountId, amount: '300000' },
    freshMinhAnhToken,
  );
  assert.equal(transferAfterUnlock.status, 201);
  assert.equal(await balance(minhAnh.accountId), '1700000');
  assert.equal(await balance(thuHa.accountId), '1300000');
  pass(
    'M-113-05',
    'POST /v1/operator/accounts/{id}/unlock -> 200 ACTIVE (audited + AccountStatusChanged outbox); subsequent 300,000 VND transfer succeeds 201 COMPLETED (balances 1,700,000 and 1,300,000)',
  );

  // M-113-06: Fail-closed rollback when audit_log insert fails, then recovery after trigger removal
  await q(
    "CREATE FUNCTION manual_dbs113_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated audit failure'; END $$",
  );
  await q(
    'CREATE TRIGGER manual_dbs113_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION manual_dbs113_fail_audit()',
  );
  try {
    const failedLock = await lock(thuHa.accountId, { reason: 'SUSPICIOUS_ACTIVITY' });
    assert.equal(failedLock.status, 500);
  } finally {
    await q('DROP TRIGGER manual_dbs113_fail_audit ON audit_log');
    await q('DROP FUNCTION manual_dbs113_fail_audit()');
  }

  const [haAccAfterFail] = await q('SELECT status FROM accounts WHERE id = $1', [thuHa.accountId]);
  const [haUserAfterFail] = await q('SELECT sessions_revoked_at FROM users WHERE id = $1', [
    thuHa.userId,
  ]);
  const [{ n: haOutboxAfterFail }] = await q(
    "SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AccountStatusChanged'",
    [thuHa.accountId],
  );
  assert.equal(haAccAfterFail.status, 'ACTIVE');
  assert.equal(haUserAfterFail.sessions_revoked_at, null);
  assert.equal(haOutboxAfterFail, 0);

  const recoveredLock = await lock(thuHa.accountId, { reason: 'SUSPICIOUS_ACTIVITY' });
  assert.equal(recoveredLock.status, 200);
  assert.equal(recoveredLock.body.status, 'LOCKED');
  pass(
    'M-113-06',
    'Audit failure aborts and rolls back status, sessions_revoked_at, and outbox (500); after removing trigger, /lock succeeds 200 LOCKED',
  );

  // M-113-07: Check all 5 ledger invariants
  await invariant();
  pass('M-113-07', 'checkLedgerInvariants PASS (all 5 ledger invariants hold with 0 violations)');
});
