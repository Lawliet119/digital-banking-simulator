import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startOnboardingApp } from '../support/onboarding-app';
import { checkLedgerInvariants } from '../support/invariants';

describe('DBS-63 real HTTP account opening and parent-row serialization', () => {
  let db: TempDatabase;
  let app: Awaited<ReturnType<typeof startOnboardingApp>>;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const open = (token: string, body: Record<string, unknown> = { type: 'CHECKING' }) =>
    request(app.url).post('/v1/accounts').auth(token, { type: 'bearer' }).send(body);
  const customer = async (onboard = true) => {
    const sub = randomUUID();
    const token = await app.issuer.token('customer', { sub });
    let id: string | undefined;
    if (onboard) {
      const res = await request(app.url)
        .post('/v1/customers/me')
        .auth(token, { type: 'bearer' })
        .send({ fullName: 'Nguyễn Minh Anh' })
        .expect(200);
      id = res.body.id;
    }
    return { sub, token, id };
  };
  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startOnboardingApp(db.url);
  });
  afterEach(async () => {
    expect((await checkLedgerInvariants(db.runner)).status).toBe('PASS');
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-63-01 opens CHECKING/SAVINGS with zero string and correct atomic audit', async () => {
    const user = await customer();
    for (const type of ['CHECKING', 'SAVINGS']) {
      const res = await open(user.token, { type }).expect(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        type,
        status: 'ACTIVE',
        balance: '0',
        createdAt: expect.stringMatching(/Z$/),
        updatedAt: expect.stringMatching(/Z$/),
      });
      const [row] = await q(
        'SELECT customer_id,type,status,balance::text FROM accounts WHERE id=$1',
        [res.body.id],
      );
      expect(row).toEqual({ customer_id: user.id, type, status: 'ACTIVE', balance: '0' });
      const [actor] = await q('SELECT id FROM users WHERE cognito_sub=$1', [user.sub]);
      expect(
        await q(
          "SELECT actor_user_id,actor_role,outcome,target_type,target_id,correlation_id,metadata FROM audit_log WHERE action='account.open' AND target_id=$1",
          [res.body.id],
        ),
      ).toEqual([
        {
          actor_user_id: actor.id,
          actor_role: 'customer',
          outcome: 'SUCCESS',
          target_type: 'account',
          target_id: res.body.id,
          correlation_id: res.headers['x-correlation-id'],
          metadata: { id: res.body.id },
        },
      ]);
    }
  });

  it('TC-63-02 fourth opening returns409 with a committed rejection audit', async () => {
    const user = await customer();
    for (let i = 0; i < 3; i++) await open(user.token).expect(201);
    const rejected = await open(user.token).expect(409);
    expect(rejected.body.errorCode).toBe('ACCOUNT_LIMIT_REACHED');
    expect(
      await q('SELECT count(*)::int AS n FROM accounts WHERE customer_id=$1', [user.id]),
    ).toEqual([{ n: 3 }]);
    expect(
      await q(
        "SELECT target_type,target_id,metadata FROM audit_log WHERE action='account.open' AND outcome='REJECTED' AND correlation_id=$1",
        [rejected.headers['x-correlation-id']],
      ),
    ).toEqual([
      {
        target_type: 'customer',
        target_id: user.id,
        metadata: { reason: 'ACCOUNT_LIMIT_REACHED', count: 3 },
      },
    ]);
  });

  it('TC-63-03 ten simultaneous first requests create exactly3 and reject7', async () => {
    const user = await customer();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        open(user.token, { type: i % 2 ? 'SAVINGS' : 'CHECKING' }),
      ),
    );
    const created = results.filter(r => r.status === 201),
      rejected = results.filter(r => r.status === 409);
    expect(created).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    expect(new Set(created.map(r => (r.body as { id: string }).id)).size).toBe(3);
    for (const res of rejected) expect(res.body.errorCode).toBe('ACCOUNT_LIMIT_REACHED');
    expect(
      await q('SELECT count(*)::int AS n FROM accounts WHERE customer_id=$1 AND balance=0', [
        user.id,
      ]),
    ).toEqual([{ n: 3 }]);
    for (const res of results) {
      const rows = await q(
        "SELECT outcome,actor_role,actor_user_id,target_type,target_id,metadata FROM audit_log WHERE action='account.open' AND correlation_id=$1",
        [res.headers['x-correlation-id']],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe(res.status === 201 ? 'SUCCESS' : 'REJECTED');
      expect(rows[0].actor_role).toBe('customer');
      const [actor] = await q('SELECT id FROM users WHERE cognito_sub=$1', [user.sub]);
      expect(rows[0].actor_user_id).toBe(actor.id);
      expect(rows[0].target_type).toBe(res.status === 201 ? 'account' : 'customer');
      expect(rows[0].target_id).toBe(res.status === 201 ? res.body.id : user.id);
      expect(rows[0].metadata).toEqual(
        res.status === 201 ? { id: res.body.id } : { reason: 'ACCOUNT_LIMIT_REACHED', count: 3 },
      );
    }
  });

  it('TC-63-04 each customer has an independent limit and cannot forge an owner', async () => {
    const a = await customer(),
      b = await customer();
    const results = await Promise.all(
      [a, b].flatMap(user => Array.from({ length: 5 }, () => open(user.token))),
    );
    expect(results.filter(r => r.status === 201)).toHaveLength(6);
    expect(results.filter(r => r.status === 409)).toHaveLength(4);
    for (const user of [a, b])
      expect(
        await q('SELECT count(*)::int AS n FROM accounts WHERE customer_id=$1', [user.id]),
      ).toEqual([{ n: 3 }]);
    await open(a.token, { type: 'CHECKING', customerId: b.id }).expect(400);
  });

  it('TC-63-05 opening really waits for its parent lock, another customer proceeds, LOCKED counts', async () => {
    const a = await customer(),
      b = await customer();
    const held = app.source.createQueryRunner();
    await held.connect();
    await held.startTransaction();
    let pending: Promise<request.Response> | undefined;
    try {
      await held.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [a.id]);
      pending = open(a.token).then(res => res);
      const deadline = Date.now() + 1500;
      let waiting = false;
      while (Date.now() < deadline) {
        const [state] = await q(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM customers%FOR UPDATE%') AS waiting",
        );
        if (state.waiting) {
          waiting = true;
          break;
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(waiting).toBe(true);
      expect(
        await q('SELECT count(*)::int AS n FROM accounts WHERE customer_id=$1', [a.id]),
      ).toEqual([{ n: 0 }]);
      await open(b.token).expect(201);
    } finally {
      await held.rollbackTransaction();
      await held.release();
    }
    expect((await pending).status).toBe(201);
    // Fixture status input only; no balance/ledger seed, future lock API is not stubbed.
    await q("UPDATE accounts SET status='LOCKED' WHERE customer_id=$1", [a.id]);
    await open(a.token).expect(201);
    await open(a.token).expect(201);
    expect((await open(a.token).expect(409)).body.errorCode).toBe('ACCOUNT_LIMIT_REACHED');
  });

  it('TC-63-06 rejects SYSTEM, invalid types and every privileged extra field', async () => {
    const user = await customer();
    for (const type of ['SYSTEM', 'checking', "CHECKING'); DROP TABLE accounts; --", '', null, 42])
      await open(user.token, { type }).expect(400);
    await open(user.token, {}).expect(400);
    for (const field of ['customerId', 'userId', 'balance', 'status', 'id'])
      await open(user.token, { type: 'CHECKING', [field]: randomUUID() }).expect(400);
    expect(
      await q('SELECT count(*)::int AS n FROM accounts WHERE customer_id=$1', [user.id]),
    ).toEqual([{ n: 0 }]);
  });

  it('TC-63-07 applies real guards and persists missing-onboarding denial before404', async () => {
    expect(
      (await request(app.url).post('/v1/accounts').send({ type: 'CHECKING' }).expect(401)).body
        .errorCode,
    ).toBe('UNAUTHENTICATED');
    const expired = await app.issuer.token('customer', { sub: randomUUID(), iat: 1, exp: 2 });
    expect((await open(expired).expect(401)).body.errorCode).toBe('TOKEN_EXPIRED');
    for (const role of ['operator', 'auditor', 'admin'] as const) {
      const token = await app.issuer.token(role, { sub: randomUUID() });
      expect((await open(token).expect(403)).body.errorCode).toBe('FORBIDDEN');
    }
    const user = await customer(false);
    const res = await open(user.token).expect(404);
    const [actor] = await q('SELECT id FROM users WHERE cognito_sub=$1', [user.sub]);
    expect(
      await q(
        "SELECT actor_user_id,outcome,target_type,target_id FROM audit_log WHERE action='account.open' AND correlation_id=$1",
        [res.headers['x-correlation-id']],
      ),
    ).toEqual([
      { actor_user_id: actor.id, outcome: 'DENIED', target_type: 'user', target_id: actor.id },
    ]);
  });

  it('TC-63-08 audit failure rolls back success; rejection/denial fail closed and recover', async () => {
    const fresh = await customer(),
      full = await customer(),
      missing = await customer(false);
    for (let i = 0; i < 3; i++) await open(full.token).expect(201);
    await q(
      "CREATE FUNCTION dbs63_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$",
    );
    await q(
      'CREATE TRIGGER dbs63_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs63_fail_audit()',
    );
    try {
      for (const user of [fresh, full, missing]) {
        const res = await open(user.token).expect(500);
        expect(res.body.detail).toBe('Internal server error');
        expect(JSON.stringify(res.body)).not.toMatch(/audit unavailable|INSERT|Nguyễn/);
        expect(
          await q(
            "SELECT count(*)::int AS n FROM audit_log WHERE action='account.open' AND correlation_id=$1",
            [res.headers['x-correlation-id']],
          ),
        ).toEqual([{ n: 0 }]);
      }
      expect(
        await q('SELECT count(*)::int AS n FROM accounts WHERE customer_id=$1', [fresh.id]),
      ).toEqual([{ n: 0 }]);
      expect(
        await q('SELECT count(*)::int AS n FROM accounts WHERE customer_id=$1', [full.id]),
      ).toEqual([{ n: 3 }]);
    } finally {
      await q('DROP TRIGGER dbs63_fail_audit ON audit_log');
      await q('DROP FUNCTION dbs63_fail_audit()');
    }
    await open(fresh.token).expect(201);
    expect((await open(full.token).expect(409)).body.errorCode).toBe('ACCOUNT_LIMIT_REACHED');
    await open(missing.token).expect(404);
  });

  it('TC-63-09 OpenAPI documents allowed types, examples, security and error responses', () => {
    const doc = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder()
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
        .build(),
    );
    const post = doc.paths['/v1/accounts'].post!;
    expect(post.security).toContainEqual({ 'access-token': [] });
    for (const status of ['201', '400', '401', '403', '404', '409', '500', '503'])
      expect(post.responses[status]).toBeDefined();
    const schema = doc.components!.schemas!.CreateAccountDto as {
      properties: { type: { enum: string[]; example: string } };
    };
    expect(schema.properties.type.enum).toEqual(['CHECKING', 'SAVINGS']);
    expect(schema.properties.type.example).toBe('CHECKING');
    expect(JSON.stringify(post.responses['409'])).toContain('ACCOUNT_LIMIT_REACHED');
  });

  it('TC-63-10 real parent lock timeout returns503 with Retry-After, then recovers', async () => {
    const user = await customer();
    const held = app.source.createQueryRunner();
    await held.connect();
    await held.startTransaction();
    try {
      await held.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [user.id]);
      const res = await open(user.token).expect(503);
      expect(res.body.errorCode).toBe('SERVICE_TEMPORARILY_UNAVAILABLE');
      expect(res.headers['retry-after']).toMatch(/^\d+$/);
      expect(
        await q('SELECT count(*)::int AS n FROM accounts WHERE customer_id=$1', [user.id]),
      ).toEqual([{ n: 0 }]);
      expect(
        await q(
          "SELECT count(*)::int AS n FROM audit_log WHERE action='account.open' AND correlation_id=$1",
          [res.headers['x-correlation-id']],
        ),
      ).toEqual([{ n: 0 }]);
    } finally {
      await held.rollbackTransaction();
      await held.release();
    }
    await open(user.token).expect(201);
  });
});
