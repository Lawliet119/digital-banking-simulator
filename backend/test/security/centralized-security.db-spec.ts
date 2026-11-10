import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp, type DepositApp } from '../support/deposit-app';
import { ErrorCode } from '../../src/common/errors/error-code.enum';

type Row = Record<string, unknown>;

describe('DBS-158 Centralized Security Test Suite (Postgres thật)', () => {
  let db: TempDatabase;
  let app: DepositApp;
  let operatorToken: string;
  let auditorToken: string;

  const q = (sql: string, args: unknown[] = []): Promise<Row[]> =>
    db.runner.query(sql, args) as Promise<Row[]>;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, { auditHttp: true, fraud: true });
    operatorToken = await app.issuer.token('operator', { sub: randomUUID() });
    auditorToken = await app.issuer.token('auditor', { sub: randomUUID() });
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  describe('AC-5.8: Tenant boundary & Cross-tenant access protection', () => {
    it('TC-158-01: accessing another customer account detail returns 404 and writes audit DENIED', async () => {
      const victim = await seedDepositTarget(db.runner);
      const attacker = await seedDepositTarget(db.runner);
      const attackerToken = await app.issuer.token('customer', { sub: attacker.sub });

      // Attacker attempts to read victim's account detail
      const res = await request(app.url)
        .get(`/v1/accounts/${victim.accountId}`)
        .auth(attackerToken, { type: 'bearer' })
        .expect(404);

      expect(res.body.status).toBe(404);

      // Verify audit_log recorded denied entry
      const deniedAudits = await q(
        `SELECT action, actor_role, outcome, target_id, actor_user_id
         FROM audit_log
         WHERE target_id = $1::text AND outcome = 'DENIED'`,
        [victim.accountId],
      );
      expect(deniedAudits.length).toBeGreaterThanOrEqual(1);
      expect(deniedAudits[0].actor_role).toBe('customer');
      expect(deniedAudits[0].actor_user_id).toBe(attacker.userId);
      expect(deniedAudits[0].outcome).toBe('DENIED');
    });

    it('TC-158-02: accessing another customer transaction history returns 404 and writes audit DENIED', async () => {
      const victim = await seedDepositTarget(db.runner);
      const attacker = await seedDepositTarget(db.runner);
      const attackerToken = await app.issuer.token('customer', { sub: attacker.sub });

      const res = await request(app.url)
        .get(`/v1/accounts/${victim.accountId}/transactions`)
        .auth(attackerToken, { type: 'bearer' })
        .expect(404);

      expect(res.body.status).toBe(404);

      const deniedAudits = await q(
        `SELECT action, actor_role, outcome, target_id, actor_user_id
         FROM audit_log
         WHERE target_id = $1::text AND outcome = 'DENIED'`,
        [victim.accountId],
      );
      expect(deniedAudits.length).toBeGreaterThanOrEqual(1);
    });

    it('TC-158-03: transferring from another customer account returns 404 and writes audit DENIED', async () => {
      const victim = await seedDepositTarget(db.runner);
      const attacker = await seedDepositTarget(db.runner);
      const attackerToken = await app.issuer.token('customer', { sub: attacker.sub });

      const res = await request(app.url)
        .post('/v1/transfers')
        .auth(attackerToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({
          fromAccountId: victim.accountId,
          toAccountId: attacker.accountId,
          amount: '50000',
        })
        .expect(404);

      expect(res.body.status).toBe(404);

      const deniedAudits = await q(
        `SELECT action, actor_role, outcome, target_id, actor_user_id
         FROM audit_log
         WHERE target_id = $1::text AND outcome = 'DENIED'`,
        [victim.accountId],
      );
      expect(deniedAudits.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('AC-8.1: Auditor read-only boundary (mutation endpoints return 403)', () => {
    it('TC-158-04: auditor cannot initiate transfers (403 FORBIDDEN)', async () => {
      const targetAcc = await seedDepositTarget(db.runner);
      const res = await request(app.url)
        .post('/v1/transfers')
        .auth(auditorToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({
          fromAccountId: targetAcc.accountId,
          toAccountId: targetAcc.accountId,
          amount: '1000',
        })
        .expect(403);

      expect(res.body.errorCode).toBe(ErrorCode.FORBIDDEN);
    });

    it('TC-158-05: auditor cannot execute operator deposits (403 FORBIDDEN)', async () => {
      const targetAcc = await seedDepositTarget(db.runner);
      const res = await request(app.url)
        .post('/v1/operator/deposits')
        .auth(auditorToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({
          toAccountId: targetAcc.accountId,
          amount: '1000',
        })
        .expect(403);

      expect(res.body.errorCode).toBe(ErrorCode.FORBIDDEN);
    });

    it('TC-158-06: auditor can search audit logs read-only (200 OK)', async () => {
      const res = await request(app.url)
        .get('/v1/audit/entries?limit=5')
        .auth(auditorToken, { type: 'bearer' })
        .expect(200);

      expect(res.body.entries).toBeDefined();
    });
  });

  describe('AC-10.2: Customer fraud flag isolation', () => {
    it('TC-158-07: customer never sees fraud flags, scores, or rule hits across any account/transfer endpoints', async () => {
      const sender = await seedDepositTarget(db.runner);
      const recipient = await seedDepositTarget(db.runner);
      const senderToken = await app.issuer.token('customer', { sub: sender.sub });

      // Deposit money
      await request(app.url)
        .post('/v1/operator/deposits')
        .auth(operatorToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ toAccountId: sender.accountId, amount: '50000000' })
        .expect(201);

      // Perform transfer
      const transferRes = await request(app.url)
        .post('/v1/transfers')
        .auth(senderToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({
          fromAccountId: sender.accountId,
          toAccountId: recipient.accountId,
          amount: '10000000',
        })
        .expect(201);

      const transferId = transferRes.body.transferId as string;

      // Seed a fraud decision and flag directly for this transfer
      await q(
        `INSERT INTO risk_decisions(transfer_id, event_id, rule_set_version, mode, rule_score, feature_snapshot, ai_status, ai_applied_weight)
         VALUES($1::uuid, $2::uuid, 1, 'rule_only', 70, '{}'::jsonb, 'DISABLED', 0)`,
        [transferId, randomUUID()],
      );
      await q(
        `INSERT INTO fraud_flags(transfer_id, score, risk_level, review_status, rule_set_version)
         VALUES($1::uuid, 70, 'HIGH', 'OPEN', 1)`,
        [transferId],
      );

      // 1. Check GET /v1/accounts
      const accountsRes = await request(app.url)
        .get('/v1/accounts')
        .auth(senderToken, { type: 'bearer' })
        .expect(200);

      const accountsJson = JSON.stringify(accountsRes.body).toLowerCase();
      expect(accountsJson).not.toContain('fraud');
      expect(accountsJson).not.toContain('risk');
      expect(accountsJson).not.toContain('score');

      // 2. Check GET /v1/accounts/:id
      const accountRes = await request(app.url)
        .get(`/v1/accounts/${sender.accountId}`)
        .auth(senderToken, { type: 'bearer' })
        .expect(200);

      const accountJson = JSON.stringify(accountRes.body).toLowerCase();
      expect(accountJson).not.toContain('fraud');
      expect(accountJson).not.toContain('risk');
      expect(accountJson).not.toContain('score');

      // 3. Check GET /v1/accounts/:id/transactions
      const txRes = await request(app.url)
        .get(`/v1/accounts/${sender.accountId}/transactions`)
        .auth(senderToken, { type: 'bearer' })
        .expect(200);

      const txJson = JSON.stringify(txRes.body).toLowerCase();
      expect(txJson).not.toContain('fraud');
      expect(txJson).not.toContain('risk');
      expect(txJson).not.toContain('score');

      // 4. Check GET /v1/transfers/:id
      const statusRes = await request(app.url)
        .get(`/v1/transfers/${transferId}`)
        .auth(senderToken, { type: 'bearer' })
        .expect(200);

      const statusJson = JSON.stringify(statusRes.body).toLowerCase();
      expect(statusJson).not.toContain('fraud');
      expect(statusJson).not.toContain('risk');
      expect(statusJson).not.toContain('score');
      expect(statusJson).not.toContain('flag');

      // 5. Customer cannot access operator fraud-flags endpoints
      await request(app.url)
        .get('/v1/operator/fraud-flags')
        .auth(senderToken, { type: 'bearer' })
        .expect(403);

      await request(app.url)
        .post(`/v1/operator/fraud-flags/${transferId}/review`)
        .auth(senderToken, { type: 'bearer' })
        .send({ decision: 'FALSE_POSITIVE' })
        .expect(403);
    });
  });
});
