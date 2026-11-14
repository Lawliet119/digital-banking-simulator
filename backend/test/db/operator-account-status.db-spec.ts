import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ErrorCode } from '@common/errors/error-code.enum';
import { validateEvent } from '@common/events';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

type App = Awaited<ReturnType<typeof startDepositApp>>;

const FUNDING = '00000000-0000-4000-8000-000000000001';
const LOCK_ACTION = 'account.lock';
const UNLOCK_ACTION = 'account.unlock';
const RESPONSE_KEYS = ['id', 'status', 'type', 'updatedAt'];

function fp(reason: string): string {
  return createHash('sha256')
    .update(reason.normalize('NFC').trim(), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * DBS-113 UC-11 / FR-ACC-03 / FR-ID-05 / BR-12 / BR-13:
 * Operator locks or unlocks a customer account in one transaction with session revocation (on lock),
 * fail-closed audit, and `AccountStatusChanged` outbox emission.
 */
describe('DBS-113 operator account lock and unlock', () => {
  let db: TempDatabase;
  let app: App;
  let operatorToken: string;
  let operatorId: string;

  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

  const lockReq = (accountId: string, body: unknown, token = operatorToken) =>
    request(app.url)
      .post(`/v1/operator/accounts/${accountId}/lock`)
      .auth(token, { type: 'bearer' })
      .send(body as object);

  const unlockReq = (accountId: string, body: unknown, token = operatorToken) =>
    request(app.url)
      .post(`/v1/operator/accounts/${accountId}/unlock`)
      .auth(token, { type: 'bearer' })
      .send(body as object);

  const deposit = (toAccountId: string, amount: string, token = operatorToken) =>
    request(app.url)
      .post('/v1/operator/deposits')
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId, amount });

  const transfer = (fromAccountId: string, toAccountId: string, amount: string, token: string) =>
    request(app.url)
      .post('/v1/transfers')
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ fromAccountId, toAccountId, amount });

  async function customer(name: string, status: 'ACTIVE' | 'LOCKED' = 'ACTIVE') {
    const row = await seedDepositTarget(db.runner, status);
    await q('UPDATE customers SET full_name = $2 WHERE id = $1', [row.customerId, name]);
    return row;
  }

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, { timeouts: { lockTimeoutMs: 250 } });
    operatorToken = await app.issuer.token('operator', { sub: randomUUID() });
    const me = await request(app.url)
      .get('/v1/identity/me')
      .auth(operatorToken, { type: 'bearer' })
      .expect(200);
    operatorId = me.body.userId as string;
  });

  afterEach(async () => {
    const inv = await checkLedgerInvariants(db.runner);
    expect(inv.status).toBe('PASS');
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-113-01 locks an ACTIVE account in one transaction: status=LOCKED, sessions_revoked_at, audit_log, and AccountStatusChanged outbox (including uppercase :id)', async () => {
    const minhAnh = await customer('Nguyễn Minh Anh');
    await deposit(minhAnh.accountId, '2000000').expect(201);

    const [beforeUser] = await q('SELECT sessions_revoked_at FROM users WHERE id = $1', [
      minhAnh.userId,
    ]);
    expect(beforeUser.sessions_revoked_at).toBeNull();

    const res = await lockReq(minhAnh.accountId.toUpperCase(), {
      reason: 'CONFIRMED_FRAUD',
    }).expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body).sort()).toEqual(RESPONSE_KEYS);
    expect(res.body).toMatchObject({
      id: minhAnh.accountId,
      type: 'CHECKING',
      status: 'LOCKED',
    });
    expect(new Date(res.body.updatedAt).toISOString()).toBe(res.body.updatedAt);
    expect(JSON.stringify(res.body)).not.toMatch(/balance|2000000|reason|CONFIRMED_FRAUD/i);

    const [accRow] = await q(
      'SELECT status, updated_at AS "updatedAt" FROM accounts WHERE id = $1',
      [minhAnh.accountId],
    );
    expect(accRow.status).toBe('LOCKED');
    expect((accRow.updatedAt as Date).toISOString()).toBe(res.body.updatedAt);

    const [userRow] = await q('SELECT sessions_revoked_at FROM users WHERE id = $1', [
      minhAnh.userId,
    ]);
    expect(userRow.sessions_revoked_at).toBeInstanceOf(Date);

    const correlationId = res.headers['x-correlation-id'];
    const audits = await q(
      'SELECT actor_user_id, actor_role, action, outcome, target_type, target_id, metadata, occurred_at FROM audit_log WHERE correlation_id = $1',
      [correlationId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: operatorId,
      actor_role: 'operator',
      action: LOCK_ACTION,
      outcome: 'SUCCESS',
      target_type: 'account',
      target_id: minhAnh.accountId,
      metadata: {
        id: fp('CONFIRMED_FRAUD'),
        reason: 'CONFIRMED_FRAUD',
      },
    });
    expect(audits[0].occurred_at).toBeInstanceOf(Date);

    const outboxRows = await q(
      "SELECT event_type, aggregate_id, payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AccountStatusChanged'",
      [minhAnh.accountId],
    );
    expect(outboxRows).toHaveLength(1);
    const payload = outboxRows[0].payload as Record<string, unknown>;
    const validated = validateEvent(payload);
    expect(validated.ok).toBe(true);
    expect(payload).toMatchObject({
      eventType: 'AccountStatusChanged',
      occurredAt: res.body.updatedAt,
      correlationId,
      accountId: minhAnh.accountId,
      ownerUserId: minhAnh.userId,
      newStatus: 'LOCKED',
      changedByUserId: operatorId,
    });
    expect(payload).not.toHaveProperty('reason');
  });

  it('TC-113-02 unlocks a LOCKED account in one transaction: status=ACTIVE, preserves sessions_revoked_at, records audit_log and AccountStatusChanged outbox', async () => {
    const thuHa = await customer('Trần Thu Hà');
    await lockReq(thuHa.accountId, { reason: 'SUSPICIOUS_ACTIVITY' }).expect(200);

    const [lockedUser] = await q('SELECT sessions_revoked_at FROM users WHERE id = $1', [
      thuHa.userId,
    ]);
    const revokedAtBefore = lockedUser.sessions_revoked_at as Date;
    expect(revokedAtBefore).toBeInstanceOf(Date);

    const freeTextReason = '  Khách đã xác minh chính chủ tại quầy  ';
    const res = await unlockReq(thuHa.accountId, { reason: freeTextReason }).expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body).sort()).toEqual(RESPONSE_KEYS);
    expect(res.body).toMatchObject({
      id: thuHa.accountId,
      type: 'CHECKING',
      status: 'ACTIVE',
    });

    const [accRow] = await q('SELECT status FROM accounts WHERE id = $1', [thuHa.accountId]);
    expect(accRow.status).toBe('ACTIVE');

    const [afterUser] = await q('SELECT sessions_revoked_at FROM users WHERE id = $1', [
      thuHa.userId,
    ]);
    expect((afterUser.sessions_revoked_at as Date).toISOString()).toBe(
      revokedAtBefore.toISOString(),
    );

    const correlationId = res.headers['x-correlation-id'];
    const audits = await q(
      'SELECT actor_user_id, actor_role, action, outcome, target_type, target_id, metadata FROM audit_log WHERE correlation_id = $1',
      [correlationId],
    );
    expect(audits).toEqual([
      {
        actor_user_id: operatorId,
        actor_role: 'operator',
        action: UNLOCK_ACTION,
        outcome: 'SUCCESS',
        target_type: 'account',
        target_id: thuHa.accountId,
        metadata: {
          id: fp('Khách đã xác minh chính chủ tại quầy'),
          reason: 'OPERATOR_UNLOCK',
        },
      },
    ]);

    const outboxRows = await q(
      "SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AccountStatusChanged' ORDER BY id ASC",
      [thuHa.accountId],
    );
    expect(outboxRows).toHaveLength(2);
    expect(outboxRows[1].payload).toMatchObject({
      eventType: 'AccountStatusChanged',
      occurredAt: res.body.updatedAt,
      correlationId,
      accountId: thuHa.accountId,
      ownerUserId: thuHa.userId,
      newStatus: 'ACTIVE',
      changedByUserId: operatorId,
    });
  });

  it('TC-113-03 is idempotent when already in the target status: no extra AccountStatusChanged outbox event and no sessions_revoked_at update, but records an audit row', async () => {
    const target = await customer('Lê Hoàng Nam');

    // Already ACTIVE -> calling /unlock does not change updatedAt or emit outbox, still audits
    const [initialAcc] = await q('SELECT updated_at AS "updatedAt" FROM accounts WHERE id = $1', [
      target.accountId,
    ]);
    const unlockAlreadyActive = await unlockReq(target.accountId, {
      reason: 'CUSTOMER_REQUEST',
    }).expect(200);
    expect(unlockAlreadyActive.body).toEqual({
      id: target.accountId,
      type: 'CHECKING',
      status: 'ACTIVE',
      updatedAt: (initialAcc.updatedAt as Date).toISOString(),
    });
    const outboxAfterNoopUnlock = await q(
      "SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AccountStatusChanged'",
      [target.accountId],
    );
    expect(outboxAfterNoopUnlock[0].n).toBe(0);

    // Transition ACTIVE -> LOCKED (1st lock)
    const firstLock = await lockReq(target.accountId, { reason: 'CONFIRMED_FRAUD' }).expect(200);
    const [afterFirstLockUser] = await q('SELECT sessions_revoked_at FROM users WHERE id = $1', [
      target.userId,
    ]);

    // Already LOCKED -> calling /lock again (2nd lock)
    const secondLock = await lockReq(target.accountId, { reason: 'COMPLIANCE_HOLD' }).expect(200);
    expect(secondLock.body).toEqual(firstLock.body);

    const [afterSecondLockUser] = await q('SELECT sessions_revoked_at FROM users WHERE id = $1', [
      target.userId,
    ]);
    expect((afterSecondLockUser.sessions_revoked_at as Date).toISOString()).toBe(
      (afterFirstLockUser.sessions_revoked_at as Date).toISOString(),
    );

    const outboxRows = await q(
      "SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AccountStatusChanged'",
      [target.accountId],
    );
    expect(outboxRows[0].n).toBe(1);

    const auditRows = await q(
      'SELECT action, metadata FROM audit_log WHERE target_type = $1 AND target_id = $2 ORDER BY id ASC',
      ['account', target.accountId],
    );
    expect(auditRows).toEqual([
      {
        action: UNLOCK_ACTION,
        metadata: { id: fp('CUSTOMER_REQUEST'), reason: 'CUSTOMER_REQUEST' },
      },
      {
        action: LOCK_ACTION,
        metadata: { id: fp('CONFIRMED_FRAUD'), reason: 'CONFIRMED_FRAUD' },
      },
      {
        action: LOCK_ACTION,
        metadata: { id: fp('COMPLIANCE_HOLD'), reason: 'COMPLIANCE_HOLD' },
      },
    ]);
  });

  it('TC-113-04 revokes active sessions on lock (AC-11.1) and rejects transfers/deposits to or from a LOCKED account until unlocked (AC-11.2)', async () => {
    const a = await customer('Phạm Quốc Bảo');
    const b = await customer('Đặng Ngọc Mai');
    await deposit(a.accountId, '1000000').expect(201);
    await deposit(b.accountId, '500000').expect(201);

    await lockReq(a.accountId, { reason: 'CONFIRMED_FRAUD' }).expect(200);

    const [userRow] = await q('SELECT sessions_revoked_at FROM users WHERE id = $1', [a.userId]);
    const revokedSec = Math.floor((userRow.sessions_revoked_at as Date).getTime() / 1000);

    // (1) Pre-lock token (iat == revokedSec) is immediately rejected with 401 SESSION_REVOKED
    const oldTokenA = await app.issuer.token('customer', { sub: a.sub, iat: revokedSec });
    const oldSessionRes = await request(app.url)
      .get('/v1/accounts')
      .auth(oldTokenA, { type: 'bearer' })
      .expect(401);
    expect(oldSessionRes.body.errorCode).toBe(ErrorCode.SESSION_REVOKED);

    // (2) Customer B transfers to LOCKED account A -> 422 ACCOUNT_NOT_ACTIVE (REJECTED row persisted)
    const tokenB = await app.issuer.token('customer', { sub: b.sub, iat: revokedSec + 1 });
    const bToA = await transfer(b.accountId, a.accountId, '100000', tokenB).expect(422);
    expect(bToA.body.errorCode).toBe(ErrorCode.ACCOUNT_NOT_ACTIVE);
    expect(bToA.body.transferId).toMatch(/^[0-9a-f-]{36}$/);

    // (3) Customer A re-authenticates (iat = revokedSec + 1) and tries to transfer from LOCKED account A,
    // and operator tries to deposit into LOCKED account A -> both 422 ACCOUNT_NOT_ACTIVE
    const freshTokenA = await app.issuer.token('customer', { sub: a.sub, iat: revokedSec + 1 });
    const aToB = await transfer(a.accountId, b.accountId, '100000', freshTokenA).expect(422);
    expect(aToB.body.errorCode).toBe(ErrorCode.ACCOUNT_NOT_ACTIVE);

    const depLocked = await deposit(a.accountId, '50000').expect(422);
    expect(depLocked.body.errorCode).toBe(ErrorCode.ACCOUNT_NOT_ACTIVE);

    const [balA, balB] = await Promise.all([
      q('SELECT balance FROM accounts WHERE id = $1', [a.accountId]),
      q('SELECT balance FROM accounts WHERE id = $1', [b.accountId]),
    ]);
    expect(balA[0].balance).toBe('1000000');
    expect(balB[0].balance).toBe('500000');

    // (4) After unlocking account A, customer B transfers 100,000 to A -> 201 COMPLETED
    await unlockReq(a.accountId, { reason: 'CUSTOMER_REQUEST' }).expect(200);
    const completed = await transfer(b.accountId, a.accountId, '100000', tokenB).expect(201);
    expect(completed.body).toMatchObject({
      status: 'COMPLETED',
    });
    expect(completed.body.transferId).toMatch(/^[0-9a-f-]{36}$/);
    const [afterBalA, afterBalB] = await Promise.all([
      q('SELECT balance FROM accounts WHERE id = $1', [a.accountId]),
      q('SELECT balance FROM accounts WHERE id = $1', [b.accountId]),
    ]);
    expect(afterBalA[0].balance).toBe('1100000');
    expect(afterBalB[0].balance).toBe('400000');
  });

  it('TC-113-05 never leaks the lock reason or its fingerprint in outbox events or any customer response (BR-13, T14)', async () => {
    const a = await customer('Vũ Thanh Tùng');
    const b = await customer('Ngô Bảo Châu');
    await deposit(a.accountId, '1000000').expect(201);

    const secretReason = 'Nghi ngờ gian lận rửa tiền hồ sơ AML-998877';
    const secretFingerprint = fp(secretReason);
    const lockRes = await lockReq(a.accountId, { reason: secretReason }).expect(200);

    const [userRow] = await q('SELECT sessions_revoked_at FROM users WHERE id = $1', [a.userId]);
    const revokedSec = Math.floor((userRow.sessions_revoked_at as Date).getTime() / 1000);
    const freshTokenA = await app.issuer.token('customer', { sub: a.sub, iat: revokedSec + 1 });

    const rejectedTx = await transfer(a.accountId, b.accountId, '100000', freshTokenA).expect(422);
    const transferId = rejectedTx.body.transferId as string;

    const listAccounts = await request(app.url)
      .get('/v1/accounts')
      .auth(freshTokenA, { type: 'bearer' })
      .expect(200);
    const getAccount = await request(app.url)
      .get(`/v1/accounts/${a.accountId}`)
      .auth(freshTokenA, { type: 'bearer' })
      .expect(200);
    const getTransactions = await request(app.url)
      .get(`/v1/accounts/${a.accountId}/transactions`)
      .auth(freshTokenA, { type: 'bearer' })
      .expect(200);
    const getTransfer = await request(app.url)
      .get(`/v1/transfers/${transferId}`)
      .auth(freshTokenA, { type: 'bearer' })
      .expect(200);
    const outboxRows = await q(
      "SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AccountStatusChanged'",
      [a.accountId],
    );

    const combinedPayloads = JSON.stringify({
      lockResponse: lockRes.body,
      outbox: outboxRows,
      rejectedTx: rejectedTx.body,
      listAccounts: listAccounts.body,
      getAccount: getAccount.body,
      getTransactions: getTransactions.body,
      getTransfer: getTransfer.body,
    });

    expect(combinedPayloads).not.toContain(secretReason);
    expect(combinedPayloads).not.toContain('AML-998877');
    expect(combinedPayloads).not.toContain(secretFingerprint);
    expect(combinedPayloads).not.toContain('OPERATOR_LOCK');
    expect(combinedPayloads).not.toContain('CONFIRMED_FRAUD');
  });

  it('TC-113-06 returns 404 for a non-existent account UUID and for the SYSTEM funding account without writing audit or outbox rows', async () => {
    const missingId = randomUUID();
    const beforeAudit = (await q('SELECT count(*)::int AS n FROM audit_log'))[0].n;
    const beforeOutbox = (await q('SELECT count(*)::int AS n FROM outbox_events'))[0].n;

    for (const targetId of [missingId, FUNDING]) {
      await lockReq(targetId, { reason: 'CONFIRMED_FRAUD' }).expect(404);
      await unlockReq(targetId, { reason: 'CUSTOMER_REQUEST' }).expect(404);
    }

    const [fundingRow] = await q('SELECT status FROM accounts WHERE id = $1', [FUNDING]);
    expect(fundingRow.status).toBe('ACTIVE');

    const afterAudit = (await q('SELECT count(*)::int AS n FROM audit_log'))[0].n;
    const afterOutbox = (await q('SELECT count(*)::int AS n FROM outbox_events'))[0].n;
    expect(afterAudit).toBe(beforeAudit);
    expect(afterOutbox).toBe(beforeOutbox);
  });

  it('TC-113-07 enforces @Roles("operator"): customer, auditor, and admin receive 403 FORBIDDEN; unauthenticated receives 401 UNAUTHENTICATED (BL-019)', async () => {
    const target = await customer('Hoàng Minh Đức');
    const beforeAudit = (await q('SELECT count(*)::int AS n FROM audit_log'))[0].n;

    const refusals: [string, string, string][] = [];
    for (const role of ['customer', 'auditor', 'admin'] as const) {
      const token = await app.issuer.token(role, { sub: randomUUID() });
      const lockForbidden = await lockReq(
        target.accountId,
        { reason: 'CONFIRMED_FRAUD' },
        token,
      ).expect(403);
      expect(lockForbidden.body.errorCode).toBe(ErrorCode.FORBIDDEN);
      refusals.push([
        role,
        'POST /v1/operator/accounts/:id/lock',
        String(lockForbidden.headers['x-correlation-id']),
      ]);

      const unlockForbidden = await unlockReq(
        target.accountId,
        { reason: 'CUSTOMER_REQUEST' },
        token,
      ).expect(403);
      expect(unlockForbidden.body.errorCode).toBe(ErrorCode.FORBIDDEN);
      refusals.push([
        role,
        'POST /v1/operator/accounts/:id/unlock',
        String(unlockForbidden.headers['x-correlation-id']),
      ]);
    }
    // BL-132 / BL-019 (AC-8.1): the refusal of the auditor (and the others) is one DENIED row each.
    for (const [role, route, correlationId] of refusals) {
      expect(
        await q(
          'SELECT actor_role, action, outcome, target_type, target_id FROM audit_log WHERE correlation_id=$1',
          [correlationId],
        ),
      ).toEqual([
        {
          actor_role: role,
          action: 'access.denied',
          outcome: 'DENIED',
          target_type: 'route',
          target_id: route,
        },
      ]);
    }

    const unauthLock = await request(app.url)
      .post(`/v1/operator/accounts/${target.accountId}/lock`)
      .send({ reason: 'CONFIRMED_FRAUD' })
      .expect(401);
    expect(unauthLock.body.errorCode).toBe(ErrorCode.UNAUTHENTICATED);

    const unauthUnlock = await request(app.url)
      .post(`/v1/operator/accounts/${target.accountId}/unlock`)
      .send({ reason: 'CUSTOMER_REQUEST' })
      .expect(401);
    expect(unauthUnlock.body.errorCode).toBe(ErrorCode.UNAUTHENTICATED);

    const [acc] = await q('SELECT status FROM accounts WHERE id = $1', [target.accountId]);
    expect(acc.status).toBe('ACTIVE');
    const afterAudit = (await q('SELECT count(*)::int AS n FROM audit_log'))[0].n;
    // Only the 6 DENIED rows above; the 401s (no identity) and the account itself add nothing.
    expect(afterAudit).toBe(beforeAudit + refusals.length);
  });

  it('TC-113-08 validates :id and reason boundaries (400 on invalid inputs, 200 on 1..200 chars and SQL injection strings)', async () => {
    const target = await customer('Bùi Thị Lan');
    const beforeAudit = (
      await q('SELECT count(*)::int AS n FROM audit_log WHERE target_id = $1', [target.accountId])
    )[0].n;

    for (const badId of ['not-a-uuid', '12345', `${target.accountId};DROP TABLE accounts`]) {
      await lockReq(badId, { reason: 'CONFIRMED_FRAUD' }).expect(400);
      await unlockReq(badId, { reason: 'CUSTOMER_REQUEST' }).expect(400);
    }

    for (const badBody of [
      {},
      { reason: '' },
      { reason: '    ' },
      { reason: 'A'.repeat(201) },
      { reason: 'Line1\nLine2' },
      { reason: 'Null\u0000char' },
      { reason: 12345 },
      { reason: 'CONFIRMED_FRAUD', status: 'ACTIVE' },
    ]) {
      await lockReq(target.accountId, badBody).expect(400);
      await unlockReq(target.accountId, badBody).expect(400);
    }

    const afterBadAudit = (
      await q('SELECT count(*)::int AS n FROM audit_log WHERE target_id = $1', [target.accountId])
    )[0].n;
    expect(afterBadAudit).toBe(beforeAudit);

    // Valid boundaries: 1 character, 200 characters, and hostile SQL text
    await lockReq(target.accountId, { reason: 'X' }).expect(200);
    await unlockReq(target.accountId, { reason: 'Đ'.repeat(200) }).expect(200);
    await lockReq(target.accountId, {
      reason: "' OR 1=1; DROP TABLE accounts; --",
    }).expect(200);
  });

  it('TC-113-09 serializes 10 concurrent /lock requests under FOR UPDATE: all 10 return 200 LOCKED, exactly 1 AccountStatusChanged event and 10 audit rows are written', async () => {
    const target = await customer('Đỗ Quang Huy');

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => lockReq(target.accountId, { reason: 'CONFIRMED_FRAUD' })),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: target.accountId,
        status: 'LOCKED',
      });
    }

    const outboxRows = await q(
      "SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AccountStatusChanged'",
      [target.accountId],
    );
    expect(outboxRows[0].n).toBe(1);

    const auditRows = await q(
      'SELECT count(*)::int AS n FROM audit_log WHERE target_type = $1 AND target_id = $2 AND action = $3',
      ['account', target.accountId, LOCK_ACTION],
    );
    expect(auditRows[0].n).toBe(10);
  });

  it('TC-113-10 rolls back status, sessions_revoked_at, audit_log, and outbox_events when audit or outbox insert fails (BR-09 fail-closed)', async () => {
    const target = await customer('Phan Văn Khải');

    await q(
      "CREATE FUNCTION dbs113_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit insert failure'; END $$",
    );
    await q(
      'CREATE TRIGGER dbs113_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs113_fail_audit()',
    );
    try {
      const failAuditRes = await lockReq(target.accountId, { reason: 'CONFIRMED_FRAUD' }).expect(
        500,
      );
      expect(failAuditRes.body.correlationId).toBeDefined();
      expect(JSON.stringify(failAuditRes.body)).not.toMatch(/audit insert failure|INSERT INTO/i);
    } finally {
      await q('DROP TRIGGER dbs113_fail_audit ON audit_log');
      await q('DROP FUNCTION dbs113_fail_audit()');
    }

    const [accAfterAuditFail] = await q('SELECT status FROM accounts WHERE id = $1', [
      target.accountId,
    ]);
    const [userAfterAuditFail] = await q('SELECT sessions_revoked_at FROM users WHERE id = $1', [
      target.userId,
    ]);
    const outboxAfterAuditFail = await q(
      'SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1',
      [target.accountId],
    );
    expect(accAfterAuditFail.status).toBe('ACTIVE');
    expect(userAfterAuditFail.sessions_revoked_at).toBeNull();
    expect(outboxAfterAuditFail[0].n).toBe(0);

    // Now test outbox failure rollback
    await q(
      "CREATE FUNCTION dbs113_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox insert failure'; END $$",
    );
    await q(
      'CREATE TRIGGER dbs113_fail_outbox BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION dbs113_fail_outbox()',
    );
    try {
      const failOutboxRes = await lockReq(target.accountId, { reason: 'CONFIRMED_FRAUD' }).expect(
        500,
      );
      expect(failOutboxRes.body.correlationId).toBeDefined();
      expect(JSON.stringify(failOutboxRes.body)).not.toMatch(/outbox insert failure|INSERT INTO/i);
    } finally {
      await q('DROP TRIGGER dbs113_fail_outbox ON outbox_events');
      await q('DROP FUNCTION dbs113_fail_outbox()');
    }

    const [accAfterOutboxFail] = await q('SELECT status FROM accounts WHERE id = $1', [
      target.accountId,
    ]);
    const [userAfterOutboxFail] = await q('SELECT sessions_revoked_at FROM users WHERE id = $1', [
      target.userId,
    ]);
    const auditAfterOutboxFail = await q(
      'SELECT count(*)::int AS n FROM audit_log WHERE target_id = $1',
      [target.accountId],
    );
    expect(accAfterOutboxFail.status).toBe('ACTIVE');
    expect(userAfterOutboxFail.sessions_revoked_at).toBeNull();
    expect(auditAfterOutboxFail[0].n).toBe(0);

    // After trigger removal, lock succeeds cleanly
    await lockReq(target.accountId, { reason: 'CONFIRMED_FRAUD' }).expect(200);
  });

  it('TC-113-11 maps lock_timeout to 503 SERVICE_TEMPORARILY_UNAVAILABLE with Retry-After and succeeds under least-privilege role dbs_api', async () => {
    const target = await customer('Trịnh Công Sơn');

    // (a) Hold a FOR UPDATE lock on the account row so /lock hits lock_timeout (250ms)
    const blocker = app.source.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    try {
      await blocker.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [target.accountId]);
      const timeoutRes = await lockReq(target.accountId, { reason: 'CONFIRMED_FRAUD' }).expect(503);
      expect(timeoutRes.body.errorCode).toBe(ErrorCode.SERVICE_TEMPORARILY_UNAVAILABLE);
      expect(timeoutRes.headers['retry-after']).toBeDefined();
    } finally {
      await blocker.rollbackTransaction();
      await blocker.release();
    }

    // (b) Execute lock and unlock through an app connected as least-privilege role `dbs_api`
    const rolesSql = readFileSync(
      resolve(__dirname, '../../../infra/scripts/db-roles.sql'),
      'utf8',
    );
    await q(rolesSql);
    await q("ALTER ROLE dbs_api LOGIN PASSWORD 'dbs113-role-test'");
    const apiUrl = new URL(db.url);
    apiUrl.username = 'dbs_api';
    apiUrl.password = 'dbs113-role-test';

    const apiRoleApp = await startDepositApp(apiUrl.toString());
    try {
      const opToken = await apiRoleApp.issuer.token('operator', { sub: randomUUID() });
      const locked = await request(apiRoleApp.url)
        .post(`/v1/operator/accounts/${target.accountId}/lock`)
        .auth(opToken, { type: 'bearer' })
        .send({ reason: 'CONFIRMED_FRAUD' })
        .expect(200);
      expect(locked.body.status).toBe('LOCKED');

      const unlocked = await request(apiRoleApp.url)
        .post(`/v1/operator/accounts/${target.accountId}/unlock`)
        .auth(opToken, { type: 'bearer' })
        .send({ reason: 'CUSTOMER_REQUEST' })
        .expect(200);
      expect(unlocked.body.status).toBe('ACTIVE');
    } finally {
      await apiRoleApp.close();
    }
  });

  it('TC-113-13 documents POST /v1/operator/accounts/{id}/lock and /unlock in OpenAPI without balance', () => {
    const doc = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder()
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
        .build(),
    );

    for (const pathKey of [
      '/v1/operator/accounts/{id}/lock',
      '/v1/operator/accounts/{id}/unlock',
    ]) {
      const route = doc.paths[pathKey]?.post;
      expect(route).toBeDefined();
      expect(route!.security).toContainEqual({ 'access-token': [] });
      expect(
        (route!.parameters as { name: string; in: string; required: boolean }[]).map(p => [
          p.name,
          p.in,
          p.required,
        ]),
      ).toContainEqual(['id', 'path', true]);
      for (const status of ['200', '400', '401', '403', '404', '500', '503']) {
        expect(route!.responses[status]).toBeDefined();
      }
    }

    expect(JSON.stringify(doc.components?.schemas?.OperatorAccountStatusResponseDto)).not.toMatch(
      /balance/i,
    );
  });
});
