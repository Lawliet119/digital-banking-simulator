import { createHash, randomUUID } from 'node:crypto';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startDepositApp, type DepositApp } from '../support/deposit-app';
import { TransferFixture } from '../support/transfer-facts-fixture';
import { modulesForRole } from '../../src/modules';
import { FraudHttpModule } from '../../src/modules/risk/fraud-http.module';
import { AppRole } from '../../src/common/app-role/app-role';
import { createRolePermissionsFixture, expectAclDenied } from '../support/db-role-permissions';

const ROOT = '/v1/operator/fraud-flags';
const RUBRIC_HASH = createHash('sha256').update('needs_operator_review').digest('hex');
describe('DBS-129/130 actual operator fraud HTTP and PostgreSQL', () => {
  let db: TempDatabase,
    app: DepositApp,
    operator: string,
    fixture: TransferFixture,
    from: string,
    to: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const get = (suffix = '', token = operator) =>
    request(app.url)
      .get(ROOT + suffix)
      .auth(token, { type: 'bearer' });
  const review = (id: string, decision = 'CONFIRMED_FRAUD') =>
    request(app.url)
      .post(`${ROOT}/${id}/review`)
      .auth(operator, { type: 'bearer' })
      .send({ decision, note: 'operator private note' });
  async function seed(at: string, ai = false): Promise<string> {
    const t = await fixture.transfer({ from, to, at });
    await q('BEGIN');
    try {
      await q(
        `INSERT INTO risk_decisions(transfer_id,event_id,rule_set_version,mode,rule_score,feature_snapshot,ai_status,ai_applied_weight,probability,provider,requested_model,response_model,rubric_sha256,input_sha256)
        VALUES($1,$2,$12,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$10,$11,$11)`,
        [
          t.id,
          randomUUID(),
          ai ? 'rules_with_external_ai' : 'rule_only',
          ai ? 0 : 55,
          '{}',
          ai ? 'SUCCEEDED' : 'DISABLED',
          ai ? 55 : 0,
          ai ? 0.95 : null,
          ai ? 'openai' : null,
          ai ? 'safe-model' : null,
          ai ? RUBRIC_HASH : null,
          ai ? 2 : 1,
        ],
      );
      await q(
        `INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version,created_at) VALUES($1,55,'MEDIUM',$3,$2)`,
        [t.id, at, ai ? 2 : 1],
      );
      if (!ai)
        await q(
          `INSERT INTO fraud_rule_hits(transfer_id,rule_id,weight,explanation) VALUES($1,'R1',30,'6 giao dịch trong 10 phút'),($1,'R2',25,'Số tiền vượt ngưỡng trung vị')`,
          [t.id],
        );
      await q('COMMIT');
    } catch (e) {
      await q('ROLLBACK');
      throw e;
    }
    return t.id;
  }
  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    // A missing real risk_decisions migration must fail, never create a test substitute.
    await q('SELECT transfer_id FROM risk_decisions LIMIT 0');
    app = await startDepositApp(db.url, { fraud: true });
    operator = await app.issuer.token('operator', { sub: randomUUID() });
    fixture = new TransferFixture(db.runner);
    [from, to] = await fixture.accounts(2);
    await q(`INSERT INTO risk_rule_sets(version,config) SELECT 2,
      jsonb_set(jsonb_set(config,'{mode}','"rules_with_external_ai"'),'{ai}',
      '{"provider":"openai","model":"safe-model","rubric":"needs_operator_review","weight":55,"threshold":0.9,"maxAdmissionDelayMs":1000,"requestTimeoutMs":1000}'::jsonb)
      FROM risk_rule_sets WHERE version=1`);
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('loads HTTP module only in API/both roles', () => {
    expect(modulesForRole(AppRole.Api)).toContain(FraudHttpModule);
    expect(modulesForRole(AppRole.Both)).toContain(FraudHttpModule);
    expect(modulesForRole(AppRole.Worker)).not.toContain(FraudHttpModule);
  });

  it('documents operator examples and problem response types in OpenAPI', () => {
    const doc = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder()
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
        .build(),
    );
    for (const [path, method] of [
      ['/v1/operator/fraud-flags', 'get'],
      ['/v1/operator/fraud-flags/{transferId}', 'get'],
      ['/v1/operator/fraud-flags/{transferId}/review', 'post'],
    ] as const) {
      const operation = doc.paths[path][method]!;
      expect(operation.security).toContainEqual({ 'access-token': [] });
      for (const status of ['400', '401', '403', '500', '503']) {
        const response = operation.responses[status];
        if (!response || '$ref' in response) throw new Error(`Missing ${status} response`);
        expect(response.content?.['application/problem+json']).toBeDefined();
      }
    }
    const review = doc.paths['/v1/operator/fraud-flags/{transferId}/review'].post!;
    const conflict = review.responses['409'];
    if (!conflict || '$ref' in conflict) throw new Error('Missing conflict response');
    expect(conflict.description).toContain('FLAG_ALREADY_REVIEWED');
    const schemas = doc.components!.schemas! as Record<
      string,
      { properties: Record<string, { example?: unknown }> }
    >;
    expect(schemas.ReviewFraudDto.properties.decision.example).toBe('FALSE_POSITIVE');
    expect(schemas.FraudAiDto.properties.probability.example).toBe(0.95);
    expect(schemas.FraudFlagDto.properties.score.example).toBe(45);
    expect(schemas.FraudProblemDto.properties.status.example).toBeUndefined();
    expect(schemas.FraudProblemDto.properties.errorCode.example).toBeUndefined();
    expect(conflict.content?.['application/problem+json'].examples).toMatchObject({
      alreadyReviewed: { value: { status: 409, errorCode: 'FLAG_ALREADY_REVIEWED' } },
    });
  });
  it('enforces actual signed token roles and does not expose existence', async () => {
    const id = await seed('2026-10-19T03:15:42.000001Z');
    for (const role of ['customer', 'admin', 'auditor'] as const) {
      const token = await app.issuer.token(role, { sub: randomUUID() });
      for (const suffix of ['', `/${id}`, `/${randomUUID()}`]) {
        const res = await get(suffix, token).expect(403);
        expect(res.body.errorCode).toBe('FORBIDDEN');
        expect(JSON.stringify(res.body)).not.toContain(id);
      }
      await request(app.url)
        .post(`${ROOT}/${id}/review`)
        .auth(token, { type: 'bearer' })
        .send({ decision: 'FALSE_POSITIVE' })
        .expect(403);
    }
    expect((await request(app.url).get(ROOT).expect(401)).body.errorCode).toBe('UNAUTHENTICATED');
    const expired = await app.issuer.token('operator', {
      sub: randomUUID(),
      iat: Math.floor(Date.now() / 1000) - 1200,
      exp: Math.floor(Date.now() / 1000) - 300,
    });
    expect((await get('', expired).expect(401)).body.errorCode).toBe('TOKEN_EXPIRED');
  });
  it('validates query, cursor, UUID and review body', async () => {
    for (const suffix of [
      '?review_status=bad',
      '?level=LOW',
      '?limit=0',
      '?limit=101',
      '?cursor=bad',
      '?level=HIGH&level=MEDIUM',
      '/not-a-uuid',
    ])
      await get(suffix).expect(400);
    const zeroYear = Buffer.from(
      JSON.stringify(['OPEN', null, 0, '0000-01-01T00:00:00.000001Z', randomUUID()]),
    ).toString('base64url');
    await get(`?cursor=${zeroYear}`).expect(400);
    const id = randomUUID();
    await review(id, 'OPEN').expect(400);
    await review(id).expect(404);
    await get(`/${id}`).expect(404);
  });
  it('audits each list with the actual operator and only safe count metadata', async () => {
    const spoofedCorrelationId = randomUUID();
    const res = await get('?limit=1').set('X-Correlation-Id', spoofedCorrelationId).expect(200);
    const correlationId = res.headers['x-correlation-id'];
    expect(correlationId).not.toBe(spoofedCorrelationId);
    const rows = await q(
      `SELECT a.actor_role,a.actor_user_id,a.metadata,a.target_type,a.target_id,
      u.id AS user_id FROM audit_log a JOIN users u ON u.id=a.actor_user_id
      WHERE a.action='fraud_flag.search' AND a.correlation_id=$1`,
      [correlationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      actor_role: 'operator',
      actor_user_id: rows[0].user_id,
      user_id: rows[0].user_id,
      metadata: { count: res.body.items.length },
      target_type: 'fraud_flag_search',
      target_id: correlationId,
    });
    expect(rows[0].actor_user_id).toBeTruthy();
  });
  it('preserves microseconds and UUID ties across every keyset page', async () => {
    const ids: string[] = [];
    for (const at of [
      '2026-10-20T00:00:00.123451Z',
      '2026-10-20T00:00:00.123452Z',
      '2026-10-20T00:00:00.123452Z',
    ])
      ids.push(await seed(at));
    const high = await seed('2026-10-19T00:00:00.000000Z');
    await q("UPDATE fraud_flags SET risk_level='HIGH',score=80 WHERE transfer_id=$1", [high]);
    ids.push(high);
    const expected = await q(
      `SELECT transfer_id FROM fraud_flags WHERE review_status='OPEN' ORDER BY CASE risk_level WHEN 'HIGH' THEN 0 ELSE 1 END,created_at DESC,transfer_id DESC`,
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await get(`?limit=1${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      seen.push(...res.body.items.map((x: { transferId: string }) => x.transferId));
      cursor = res.body.nextCursor as string | null;
      if (cursor) await get(`?limit=1&level=HIGH&cursor=${cursor}`).expect(400);
    } while (cursor);
    expect(seen).toEqual(expected.map((x: { transfer_id: string }) => x.transfer_id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(ids.every(id => seen.includes(id))).toBe(true);
  });
  it('returns only the ten most recent ledger movements of the flagged sender', async () => {
    const transfers: string[] = [];
    for (let i = 0; i < 12; i++) {
      const at = new Date(Date.parse('2026-09-01T00:00:00Z') + i * 1000).toISOString();
      const row = await fixture.transfer({ from, to, at });
      transfers.push(row.id);
      await q(
        `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after,created_at)
         VALUES($1,$2,'DEBIT',500000,1000000,$3::timestamptz)`,
        [row.id, from, at],
      );
    }
    const flag = await seed('2026-10-20T12:00:00.000000Z');
    const response = await get(`/${flag}`).expect(200);
    expect(
      response.body.recentTransactions.map((row: { transferId: string }) => row.transferId),
    ).toEqual(transfers.slice(2).reverse());
    expect(response.body.recentTransactions[0]).toMatchObject({
      type: 'TRANSFER',
      direction: 'DEBIT',
      amount: '500000',
      balanceAfter: '1000000',
      counterpartyAccountId: to,
    });
  });
  it('returns canonical baseline/AI-only detail with allowlisted provenance and access audit', async () => {
    for (const ai of [false, true]) {
      const id = await seed('2026-10-21T00:00:00.000001Z', ai);
      const res = await get(`/${id}`).expect(200);
      expect(res.body.score).toBe(55);
      expect(res.body.hits).toHaveLength(ai ? 0 : 2);
      expect(res.body.aiAssessment).toEqual(
        ai
          ? {
              status: 'SUCCEEDED',
              probability: 0.95,
              model: 'safe-model',
              rubricSha256: RUBRIC_HASH,
            }
          : null,
      );
      expect(JSON.stringify(res.body)).not.toMatch(
        /feature_snapshot|inputSha|requestId|provider|Authorization|private note/,
      );
      const audit = await q(
        `SELECT actor_role,actor_user_id FROM audit_log WHERE action='fraud_flag.view' AND target_id=$1`,
        [id],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_role).toBe('operator');
      expect(audit[0].actor_user_id).toBeTruthy();
    }
  });
  it('fails closed for list/detail and rolls review back when real audit INSERT fails', async () => {
    const id = await seed('2026-10-22T00:00:00.000001Z');
    await q(
      `CREATE FUNCTION reject_fraud_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('fraud_flag.search','fraud_flag.view','fraud_flag.review') THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`,
    );
    await q(
      'CREATE TRIGGER reject_fraud_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_fraud_audit()',
    );
    try {
      const list = await get().expect(500);
      expect(list.body).not.toHaveProperty('items');
      expect(JSON.stringify(list.body)).not.toContain(id);
      expect(JSON.stringify(list.body)).not.toMatch(/fromAccountId|toAccountId|audit unavailable/);
      const read = await get(`/${id}`).expect(500);
      expect(JSON.stringify(read.body)).not.toContain('6 giao');
      await review(id).expect(500);
      const [row] = await q(
        'SELECT review_status,reviewed_by,reviewed_at FROM fraud_flags WHERE transfer_id=$1',
        [id],
      );
      expect(row).toEqual({ review_status: 'OPEN', reviewed_by: null, reviewed_at: null });
    } finally {
      await q('DROP TRIGGER reject_fraud_audit ON audit_log');
      await q('DROP FUNCTION reject_fraud_audit()');
    }
  });
  it('allows exactly one simultaneous review with correct actor and exactly one audit, no outbox', async () => {
    const id = await seed('2026-10-23T00:00:00.000001Z');
    const [before] = await q('SELECT count(*)::int AS n FROM outbox_events');
    const results = await Promise.all([review(id), review(id, 'FALSE_POSITIVE')]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.find(r => r.status === 409)!.body.errorCode).toBe('FLAG_ALREADY_REVIEWED');
    const [row] = await q(
      'SELECT review_status,reviewed_by,reviewed_at,review_note FROM fraud_flags WHERE transfer_id=$1',
      [id],
    );
    expect(row.review_status).toBe(results.find(r => r.status === 200)!.body.reviewStatus);
    expect(row.reviewed_at).toBeTruthy();
    expect(row.review_note).toBe('operator private note');
    const audit = await q(
      `SELECT actor_user_id,actor_role,metadata FROM audit_log WHERE action='fraud_flag.review' AND target_id=$1`,
      [id],
    );
    expect(audit).toEqual([
      {
        actor_user_id: row.reviewed_by,
        actor_role: 'operator',
        metadata: {
          reason:
            row.review_status === 'CONFIRMED_FRAUD' ? 'FRAUD_CONFIRMED' : 'FRAUD_FALSE_POSITIVE',
        },
      },
    ]);
    const [after] = await q('SELECT count(*)::int AS n FROM outbox_events');
    expect(after.n).toBe(before.n);
  });
  it('combines status and level filters and rejects a second sequential review', async () => {
    const id = await seed('2026-10-24T00:00:00.000001Z');
    await q("UPDATE fraud_flags SET risk_level='HIGH',score=80 WHERE transfer_id=$1", [id]);
    await review(id, 'FALSE_POSITIVE').expect(200);
    await review(id).expect(409);
    const selected = await get('?review_status=FALSE_POSITIVE&level=HIGH').expect(200);
    expect(selected.body.items.map((row: { transferId: string }) => row.transferId)).toContain(id);
    const excluded = await get('?review_status=FALSE_POSITIVE&level=MEDIUM').expect(200);
    expect(excluded.body.items.map((row: { transferId: string }) => row.transferId)).not.toContain(
      id,
    );
  });
  it.each([
    ['CONFIRMED_FRAUD', 'FRAUD_CONFIRMED'],
    ['FALSE_POSITIVE', 'FRAUD_FALSE_POSITIVE'],
  ])(
    'audits actor and exact conclusion for %s without the private note',
    async (decision, reason) => {
      const id = await seed('2026-10-25T00:00:00.000001Z');
      await review(id, decision).expect(200);
      const rows = await q(
        `SELECT a.actor_user_id,a.actor_role,a.metadata,f.reviewed_by
       FROM audit_log a JOIN fraud_flags f ON f.transfer_id=$1
       WHERE a.target_id=$1::text AND a.action='fraud_flag.review'`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        actor_user_id: rows[0].reviewed_by,
        reviewed_by: rows[0].reviewed_by,
        actor_role: 'operator',
        metadata: { reason },
      });
      expect(rows[0].actor_user_id).toBeTruthy();
    },
  );
});

describe('DBS-129/130 restricted dbs_api HTTP', () => {
  it('reads and reviews through actual runtime grants without expanding write privileges', async () => {
    const fixture = await createRolePermissionsFixture({ fraud: true });
    try {
      const id = fixture.transfers[0].id;
      await fixture.owner.query(
        "INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version) VALUES($1,55,'MEDIUM',1)",
        [id],
      );
      const token = await fixture.app.issuer.token('operator', { sub: randomUUID() });
      const http = () => request(fixture.app.url);
      await http().get(ROOT).auth(token, { type: 'bearer' }).expect(200);
      const detail = await http().get(`${ROOT}/${id}`).auth(token, { type: 'bearer' }).expect(200);
      expect(detail.body.recentTransactions.length).toBeGreaterThan(0);
      expect(detail.body.aiAssessment).toBeNull();
      await http()
        .post(`${ROOT}/${id}/review`)
        .auth(token, { type: 'bearer' })
        .send({ decision: 'FALSE_POSITIVE' })
        .expect(200);
      await expectAclDenied(fixture.api, 'UPDATE fraud_flags SET score=99 WHERE transfer_id=$1', [
        id,
      ]);
      await expectAclDenied(fixture.api, 'DELETE FROM fraud_flags WHERE transfer_id=$1', [id]);
      await expectAclDenied(fixture.api, 'DELETE FROM risk_decisions WHERE transfer_id=$1', [id]);
      const audit = await fixture.owner.query(
        "SELECT action FROM audit_log WHERE target_id=$1 AND action IN ('fraud_flag.view','fraud_flag.review')",
        [id],
      );
      expect(audit).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });
});
