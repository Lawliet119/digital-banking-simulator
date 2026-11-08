import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type Row = Awaited<ReturnType<typeof seedDepositTarget>>;
const FUNDING = '00000000-0000-4000-8000-000000000001';

/** DBS-87 UC-7: status of one transfer, for its sender and (once COMPLETED) its recipient only. */
describe('DBS-87 transfer status (UC-7)', () => {
  let db: TempDatabase, app: App, operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const get = async (row: Row, id: string) =>
    request(app.url)
      .get(`/v1/transfers/${id}`)
      .auth(await app.issuer.token('customer', { sub: row.sub }), { type: 'bearer' });
  const deposit = (to: string, amount: string) =>
    request(app.url)
      .post('/v1/operator/deposits')
      .auth(operator, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: to, amount });
  const funded = async (amount: string, status: 'ACTIVE' | 'LOCKED' = 'ACTIVE'): Promise<Row> => {
    const row = await seedDepositTarget(db.runner);
    expect((await deposit(row.accountId, amount)).status).toBe(201);
    if (status === 'LOCKED')
      await q("UPDATE accounts SET status='LOCKED' WHERE id=$1", [row.accountId]);
    return row;
  };
  const send = async (from: Row, toAccountId: string, amount: string) =>
    request(app.url)
      .post('/v1/transfers')
      .auth(await app.issuer.token('customer', { sub: from.sub }), { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ fromAccountId: from.accountId, toAccountId, amount });

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    operator = await app.issuer.token('operator', { sub: randomUUID() });
  });
  afterEach(async () => {
    const result = await checkLedgerInvariants(db.runner);
    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-87-07 sender and recipient read a COMPLETED transfer; anyone else gets the same 404 + DENIED', async () => {
    const giang = await funded('1000000'),
      hai = await funded('1000'),
      khanh = await funded('1000');
    const sent = await send(giang, hai.accountId, '300000');
    expect(sent.status).toBe(201);
    const transferId = sent.body.transferId as string;
    for (const row of [giang, hai]) {
      const res = await get(row, transferId);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        transferId,
        type: 'TRANSFER',
        status: 'COMPLETED',
        amount: '300000',
        fromAccountId: giang.accountId,
        toAccountId: hai.accountId,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:]{8}\.\d{6}Z$/),
      });
    }
    let shape: unknown;
    for (const id of [transferId, randomUUID(), 'not-a-uuid', transferId.toUpperCase() + 'x']) {
      const res = await get(khanh, id);
      expect(res.status).toBe(404);
      const { correlationId: _cid, ...body } = res.body;
      if (!shape) shape = body;
      else expect(body).toEqual(shape);
      expect(JSON.stringify(res.body)).not.toContain(giang.accountId);
      const [audit] = await q(
        "SELECT outcome,metadata,target_type FROM audit_log WHERE action='transfer.read' AND correlation_id=$1",
        [res.headers['x-correlation-id']],
      );
      expect(audit.outcome).toBe('DENIED');
      expect(audit.metadata).toEqual({ reason: 'NOT_OWNER' });
    }
  });

  it('TC-87-08 REJECTED: the sender sees the reason and no destination; three kinds of refused destination look alike', async () => {
    const giang = await funded('1000000'),
      locked = await funded('1000', 'LOCKED');
    const ids: Record<string, string> = {};
    for (const [label, to] of [
      ['missing', randomUUID()],
      ['funding', FUNDING],
      ['locked', locked.accountId],
    ] as const) {
      const res = await send(giang, to, '100');
      expect({ label, status: res.status }).toEqual({ label, status: 422 });
      expect(res.body.errorCode).toBe('ACCOUNT_NOT_ACTIVE');
      ids[label] = res.body.transferId as string;
    }
    const views: Record<string, Record<string, unknown>> = {};
    for (const label of Object.keys(ids)) {
      const res = await get(giang, ids[label]);
      expect(res.status).toBe(200);
      views[label] = res.body;
      expect(Object.keys(res.body).sort()).toEqual([
        'amount',
        'createdAt',
        'fromAccountId',
        'rejectReason',
        'status',
        'transferId',
        'type',
      ]);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        rejectReason: 'ACCOUNT_NOT_ACTIVE',
        amount: '100',
        fromAccountId: giang.accountId,
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(locked.accountId);
      expect(text).not.toContain(FUNDING);
    }
    // Apart from the transferId and the time, the three answers are identical.
    const strip = ({ transferId: _t, createdAt: _c, ...rest }: Record<string, unknown>) => rest;
    expect(strip(views.missing)).toEqual(strip(views.funding));
    expect(strip(views.missing)).toEqual(strip(views.locked));
    // The holder of the LOCKED destination cannot read a REJECTED transfer aimed at them.
    const theirs = await get(locked, ids.locked);
    expect(theirs.status).toBe(404);
    expect(JSON.stringify(theirs.body)).not.toContain(giang.accountId);
    // A short balance is read the same way.
    const short = await send(giang, locked.accountId, '99999999');
    const readShort = await get(giang, short.body.transferId as string);
    expect(readShort.body).toMatchObject({ status: 'REJECTED' });
    expect(readShort.body.toAccountId).toBeUndefined();
  });

  it('TC-87-10 a deposit is readable by the receiver and hides the funding account; a refused deposit by nobody', async () => {
    const hai = await seedDepositTarget(db.runner);
    const made = await deposit(hai.accountId, '2500000');
    expect(made.status).toBe(201);
    const res = await get(hai, made.body.transferId as string);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transferId: made.body.transferId,
      type: 'DEPOSIT',
      status: 'COMPLETED',
      amount: '2500000',
      toAccountId: hai.accountId,
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain(FUNDING);
    const locked = await funded('1000', 'LOCKED');
    const refused = await deposit(locked.accountId, '100');
    expect(refused.status).toBe(422);
    expect((await get(locked, refused.body.transferId as string)).status).toBe(404);
  });

  it('TC-87-09 AC-10.2 the status carries nothing about fraud flags', async () => {
    const giang = await funded('10000000'),
      hai = await seedDepositTarget(db.runner);
    const sent = await send(giang, hai.accountId, '9000000');
    const transferId = sent.body.transferId as string;
    await q(
      "INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version) VALUES($1,85,'HIGH',1)",
      [transferId],
    );
    for (const row of [giang, hai]) {
      const res = await get(row, transferId);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual([
        'amount',
        'createdAt',
        'fromAccountId',
        'status',
        'toAccountId',
        'transferId',
        'type',
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/fraud|flag|risk|score|review|rule|HIGH/i);
    }
  });

  it('TC-87-11 a successful read is audited in the same transaction; no audit, no data', async () => {
    const giang = await funded('1000000'),
      hai = await seedDepositTarget(db.runner);
    const transferId = (await send(giang, hai.accountId, '1000')).body.transferId as string;
    const res = await get(giang, transferId);
    const [audit] = await q(
      "SELECT actor_user_id,actor_role,outcome,target_type,target_id,metadata FROM audit_log WHERE action='transfer.read' AND correlation_id=$1",
      [res.headers['x-correlation-id']],
    );
    expect(audit).toMatchObject({
      actor_user_id: giang.userId,
      actor_role: 'customer',
      outcome: 'SUCCESS',
      target_type: 'transfer',
      target_id: transferId,
      metadata: { id: transferId },
    });
    await q(
      "CREATE FUNCTION dbs87_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$",
    );
    await q(
      'CREATE TRIGGER dbs87_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs87_fail_audit()',
    );
    try {
      const failed = await get(giang, transferId);
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.body)).not.toMatch(/COMPLETED|audit unavailable|SELECT|amount/);
    } finally {
      await q('DROP TRIGGER dbs87_fail_audit ON audit_log');
      await q('DROP FUNCTION dbs87_fail_audit()');
    }
    expect((await get(giang, transferId)).status).toBe(200);
  });

  it('TC-87-13 customer only, and Swagger documents the route', async () => {
    const giang = await funded('1000');
    for (const role of ['operator', 'auditor', 'admin'] as const) {
      const jwt = await app.issuer.token(role, { sub: randomUUID() });
      await request(app.url)
        .get(`/v1/transfers/${randomUUID()}`)
        .auth(jwt, { type: 'bearer' })
        .expect(403);
    }
    await request(app.url).get(`/v1/transfers/${randomUUID()}`).expect(401);
    expect(giang.accountId).toBeDefined();
    const doc = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder()
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
        .build(),
    );
    const route = doc.paths['/v1/transfers/{id}'].get!;
    expect(route.security).toContainEqual({ 'access-token': [] });
    for (const status of ['200', '401', '403', '404', '500', '503'])
      expect(route.responses[status]).toBeDefined();
  });
});
