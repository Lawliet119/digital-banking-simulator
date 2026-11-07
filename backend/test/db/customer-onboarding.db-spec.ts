import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startOnboardingApp } from '../support/onboarding-app';

describe('DBS-62 HTTP onboarding on real PostgreSQL and local JWT', () => {
  let db: TempDatabase;
  let stack: Awaited<ReturnType<typeof startOnboardingApp>>;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    stack = await startOnboardingApp(db.url);
  });
  afterAll(async () => {
    try {
      await stack?.close();
    } finally {
      await db?.drop();
    }
  });
  const customer = async () => {
    const sub = randomUUID();
    return { sub, token: await stack.issuer.token('customer', { sub }) };
  };
  it('TC-62-01/02 creates normalized profile, audits once and replays unchanged', async () => {
    const user = await customer();
    const res = await request(stack.url)
      .post('/v1/customers/me')
      .auth(user.token, { type: 'bearer' })
      .send({ fullName: '  Nguyễn Minh Anh  ' })
      .expect(200);
    expect(res.body).toMatchObject({ fullName: 'Nguyễn Minh Anh' });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.createdAt).toMatch(/Z$/);
    const replay = await request(stack.url)
      .post('/v1/customers/me')
      .auth(user.token, { type: 'bearer' })
      .send({ fullName: 'Tên khác' })
      .expect(200);
    expect(replay.body).toEqual(res.body);
    const reads = await q(
      "SELECT actor_role,target_id,correlation_id FROM audit_log WHERE action='customer.read' AND target_id=$1",
      [res.body.id],
    );
    expect(reads).toEqual([
      {
        actor_role: 'customer',
        target_id: res.body.id,
        correlation_id: replay.headers['x-correlation-id'],
      },
    ]);
    const rows = await q(
      'SELECT actor_user_id,actor_role,target_id,correlation_id,metadata FROM audit_log WHERE action=$1 AND target_id=$2',
      ['customer.created', res.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_role: 'customer',
      target_id: res.body.id,
      correlation_id: res.headers['x-correlation-id'],
      metadata: { id: res.body.id },
    });
    expect(
      await q('SELECT count(*)::int AS n FROM accounts WHERE customer_id=$1', [res.body.id]),
    ).toEqual([{ n: 0 }]);
  });
  it('TC-62-03 twenty real first requests converge to exactly one customer and creation audit', async () => {
    const user = await customer();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(stack.url)
          .post('/v1/customers/me')
          .auth(user.token, { type: 'bearer' })
          .send({ fullName: 'Trần Thu Hà' }),
      ),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual(responses[0].body);
    }
    expect(
      await q('SELECT count(*)::int AS n FROM users WHERE cognito_sub=$1', [user.sub]),
    ).toEqual([{ n: 1 }]);
    expect(
      await q(
        'SELECT count(*)::int AS n FROM customers c JOIN users u ON c.user_id=u.id WHERE u.cognito_sub=$1',
        [user.sub],
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await q(
        "SELECT count(*)::int AS n FROM audit_log WHERE action='customer.created' AND target_id=$1",
        [responses[0].body.id],
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await q(
        "SELECT count(*)::int AS n FROM audit_log WHERE action='customer.read' AND target_id=$1",
        [responses[0].body.id],
      ),
    ).toEqual([{ n: 19 }]);
  });
  it('TC-62-04 GET is owned and missing profile404; forged owner fields rejected', async () => {
    const a = await customer(),
      b = await customer();
    await request(stack.url).get('/v1/customers/me').auth(a.token, { type: 'bearer' }).expect(404);
    const profile = await request(stack.url)
      .post('/v1/customers/me')
      .auth(a.token, { type: 'bearer' })
      .send({ fullName: 'Lê Hoàng Nam' })
      .expect(200);
    const own = await request(stack.url)
      .get('/v1/customers/me')
      .auth(a.token, { type: 'bearer' })
      .expect(200);
    expect(own.body).toEqual(profile.body);
    const readAudit = await q(
      "SELECT actor_user_id,target_id,correlation_id FROM audit_log WHERE action='customer.read' AND correlation_id=$1",
      [own.headers['x-correlation-id']],
    );
    const [actor] = await q('SELECT id FROM users WHERE cognito_sub=$1', [a.sub]);
    expect(readAudit).toEqual([
      {
        actor_user_id: actor.id,
        target_id: profile.body.id,
        correlation_id: own.headers['x-correlation-id'],
      },
    ]);
    await request(stack.url)
      .get('/v1/customers/me?userId=' + profile.body.id)
      .auth(b.token, { type: 'bearer' })
      .expect(404);
    await request(stack.url)
      .post('/v1/customers/me')
      .auth(b.token, { type: 'bearer' })
      .send({ fullName: 'Nguyễn An', userId: profile.body.id, role: 'admin' })
      .expect(400);
  });
  it('TC-62-05 real auth guards reject missing/expired and staff tokens', async () => {
    const missing = await request(stack.url)
      .post('/v1/customers/me')
      .send({ fullName: 'Nguyễn An' })
      .expect(401);
    expect(missing.body.errorCode).toBe('UNAUTHENTICATED');
    const expired = await stack.issuer.token('customer', { sub: randomUUID(), iat: 1, exp: 2 });
    const res = await request(stack.url)
      .post('/v1/customers/me')
      .auth(expired, { type: 'bearer' })
      .send({ fullName: 'Nguyễn An' })
      .expect(401);
    expect(res.body.errorCode).toBe('TOKEN_EXPIRED');
    for (const role of ['operator', 'auditor', 'admin'] as const) {
      const token = await stack.issuer.token(role, { sub: randomUUID() });
      const denied = await request(stack.url)
        .post('/v1/customers/me')
        .auth(token, { type: 'bearer' })
        .send({ fullName: 'Nguyễn An' })
        .expect(403);
      expect(denied.body.errorCode).toBe('FORBIDDEN');
    }
  });
  it('TC-62-06 validation and SQL-like names use parameterized storage, metadata contains no PII', async () => {
    const user = await customer();
    for (const fullName of ['', '   ', 'a'.repeat(201), 'bad\u0000name', 42, null])
      await request(stack.url)
        .post('/v1/customers/me')
        .auth(user.token, { type: 'bearer' })
        .send({ fullName })
        .expect(400);
    const name = "O'Neil'); DROP TABLE customers; --";
    const result = await request(stack.url)
      .post('/v1/customers/me')
      .auth(user.token, { type: 'bearer' })
      .send({ fullName: name })
      .expect(200);
    expect(result.body.fullName).toBe(name);
    const [audit] = await q(
      "SELECT metadata FROM audit_log WHERE action='customer.created' AND target_id=$1",
      [result.body.id],
    );
    expect(audit.metadata).toEqual({ id: result.body.id });
    const boundary = await customer();
    await request(stack.url)
      .post('/v1/customers/me')
      .auth(boundary.token, { type: 'bearer' })
      .send({ fullName: 'a'.repeat(200) })
      .expect(200);
  });
  it('TC-62-07 audit DB failure rolls back the customer; retry after recovery succeeds', async () => {
    const existing = await customer();
    const original = await request(stack.url)
      .post('/v1/customers/me')
      .auth(existing.token, { type: 'bearer' })
      .send({ fullName: 'Đỗ Minh Châu' })
      .expect(200);
    const user = await customer();
    await q(
      "CREATE FUNCTION dbs62_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$",
    );
    await q(
      'CREATE TRIGGER dbs62_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs62_fail_audit()',
    );
    try {
      const response = await request(stack.url)
        .post('/v1/customers/me')
        .auth(user.token, { type: 'bearer' })
        .send({ fullName: 'Phạm Ngọc Lan' })
        .expect(500);
      expect(response.body.detail).toBe('Internal server error');
      expect(JSON.stringify(response.body)).not.toContain('audit unavailable');
      expect(
        await q(
          'SELECT count(*)::int AS n FROM customers c JOIN users u ON c.user_id=u.id WHERE u.cognito_sub=$1',
          [user.sub],
        ),
      ).toEqual([{ n: 0 }]);
      const read = await request(stack.url)
        .get('/v1/customers/me')
        .auth(existing.token, { type: 'bearer' })
        .expect(500);
      expect(JSON.stringify(read.body)).not.toContain(original.body.fullName);
      await request(stack.url)
        .post('/v1/customers/me')
        .auth(existing.token, { type: 'bearer' })
        .send({ fullName: 'Tên không được thay đổi' })
        .expect(500);
      expect(await q('SELECT full_name FROM customers WHERE id=$1', [original.body.id])).toEqual([
        { full_name: original.body.fullName },
      ]);
      expect(
        await q('SELECT count(*)::int AS n FROM audit_log WHERE target_id=$1', [original.body.id]),
      ).toEqual([{ n: 1 }]);
    } finally {
      await q('DROP TRIGGER dbs62_fail_audit ON audit_log');
      await q('DROP FUNCTION dbs62_fail_audit()');
    }
    await request(stack.url)
      .post('/v1/customers/me')
      .auth(user.token, { type: 'bearer' })
      .send({ fullName: 'Phạm Ngọc Lan' })
      .expect(200);
  });
  it('TC-62-08 OpenAPI documents security, DTO and responses', () => {
    const doc = SwaggerModule.createDocument(
      stack.app,
      new DocumentBuilder()
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
        .build(),
    );
    const route = doc.paths['/v1/customers/me'];
    expect(route.post?.security).toContainEqual({ 'access-token': [] });
    expect(route.post?.responses['200']).toBeDefined();
    expect(route.post?.responses['400']).toBeDefined();
    expect(route.get?.responses['404']).toBeDefined();
  });
});
