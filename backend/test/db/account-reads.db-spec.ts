import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startOnboardingApp } from '../support/onboarding-app';
import { checkLedgerInvariants } from '../support/invariants';
import { toAccountView } from '../../src/modules/accounts/account-view.dto';

describe('DBS-64 own account reads over real HTTP/JWT/PostgreSQL', () => {
  let db: TempDatabase;
  let app: Awaited<ReturnType<typeof startOnboardingApp>>;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const get = (token: string, suffix = '') =>
    request(app.url)
      .get('/v1/accounts' + suffix)
      .auth(token, { type: 'bearer' });
  const customer = async (count = 0, onboard = true) => {
    const sub = randomUUID(),
      token = await app.issuer.token('customer', { sub });
    if (onboard)
      await request(app.url)
        .post('/v1/customers/me')
        .auth(token, { type: 'bearer' })
        .send({ fullName: 'Trần Thu Hà' })
        .expect(200);
    const accounts: {
      id: string;
      type: string;
      status: string;
      balance: string;
      createdAt: string;
      updatedAt: string;
    }[] = [];
    for (let i = 0; i < count; i++) {
      const res = await request(app.url)
        .post('/v1/accounts')
        .auth(token, { type: 'bearer' })
        .send({ type: i % 2 ? 'SAVINGS' : 'CHECKING' })
        .expect(201);
      accounts.push(res.body);
    }
    return { sub, token, accounts };
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

  it('TC-64-01 lists only owned accounts with safe DTOs, stable order and committed list audit', async () => {
    const user = await customer(3),
      other = await customer(1);
    const res = await get(user.token).expect(200);
    const expected = [...user.accounts].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    expect(res.body).toEqual(expected);
    expect(JSON.stringify(res.body)).not.toContain(other.accounts[0].id);
    const [actor] = await q('SELECT id FROM users WHERE cognito_sub=$1', [user.sub]);
    expect(
      await q(
        "SELECT actor_user_id,actor_role,outcome,target_type,target_id,metadata FROM audit_log WHERE action='account.list' AND correlation_id=$1",
        [res.headers['x-correlation-id']],
      ),
    ).toEqual([
      {
        actor_user_id: actor.id,
        actor_role: 'customer',
        outcome: 'SUCCESS',
        target_type: 'user',
        target_id: actor.id,
        metadata: { count: 3 },
      },
    ]);
    for (const account of res.body) {
      expect(typeof account.balance).toBe('string');
      expect(Object.keys(account).sort()).toEqual(
        ['id', 'type', 'status', 'balance', 'createdAt', 'updatedAt'].sort(),
      );
    }
  });

  it('TC-64-02 detail matches list, accepts uppercase UUID and sees latest committed LOCKED status', async () => {
    const user = await customer(1),
      account = user.accounts[0];
    const res = await get(user.token, '/' + account.id.toUpperCase()).expect(200);
    expect(res.body).toEqual(account);
    const [actor] = await q('SELECT id FROM users WHERE cognito_sub=$1', [user.sub]);
    expect(
      await q(
        "SELECT actor_user_id,actor_role,outcome,target_type,target_id,metadata FROM audit_log WHERE action='account.read' AND correlation_id=$1",
        [res.headers['x-correlation-id']],
      ),
    ).toEqual([
      {
        actor_user_id: actor.id,
        actor_role: 'customer',
        outcome: 'SUCCESS',
        target_type: 'account',
        target_id: account.id,
        metadata: { id: account.id },
      },
    ]);
    // Status-only input fixture; no balance or ledger seed and no future lock API stub.
    await q("UPDATE accounts SET status='LOCKED' WHERE id=$1", [account.id]);
    expect((await get(user.token, '/' + account.id).expect(200)).body).toEqual({
      ...account,
      status: 'LOCKED',
    });
    expect((await get(user.token).expect(200)).body).toEqual([{ ...account, status: 'LOCKED' }]);
  });

  it('TC-64-03 foreign/missing/SYSTEM/malformed ids share404 and retain safe DENIED audits', async () => {
    const a = await customer(),
      b = await customer(1);
    let shape: unknown;
    for (const id of [
      b.accounts[0].id,
      randomUUID(),
      '00000000-0000-4000-8000-000000000001',
      'private-email@example.com',
    ]) {
      const res = await get(a.token, '/' + encodeURIComponent(id)).expect(404);
      const { correlationId: _cid, ...body } = res.body;
      if (!shape) shape = body;
      else expect(body).toEqual(shape);
      expect(JSON.stringify(res.body)).not.toContain(id);
      const [audit] = await q(
        "SELECT actor_user_id,outcome,target_type,target_id,metadata FROM audit_log WHERE action='account.read' AND correlation_id=$1",
        [res.headers['x-correlation-id']],
      );
      const [actor] = await q('SELECT id FROM users WHERE cognito_sub=$1', [a.sub]);
      expect(audit.actor_user_id).toBe(actor.id);
      expect(audit.outcome).toBe('DENIED');
      expect(audit.metadata).toEqual({ reason: 'NOT_OWNER' });
      expect(audit.target_type).toBe(id.includes('@') ? 'user' : 'account');
      expect(audit.target_id).toBe(id.includes('@') ? actor.id : id);
    }
  });

  it('TC-64-04 empty and unonboarded users see[]; forged query cannot select another owner', async () => {
    const empty = await customer(),
      missing = await customer(0, false),
      other = await customer(1);
    for (const user of [empty, missing]) {
      const res = await get(
        user.token,
        '?userId=' + other.sub + '&customerId=' + other.accounts[0].id,
      ).expect(200);
      expect(res.body).toEqual([]);
      expect(
        await q(
          "SELECT metadata FROM audit_log WHERE action='account.list' AND correlation_id=$1",
          [res.headers['x-correlation-id']],
        ),
      ).toEqual([{ metadata: { count: 0 } }]);
    }
  });

  it('TC-64-05 actual JWT/role guards protect both GET endpoints', async () => {
    const expired = await app.issuer.token('customer', { sub: randomUUID(), iat: 1, exp: 2 });
    for (const suffix of ['', '/' + randomUUID()]) {
      expect(
        (
          await request(app.url)
            .get('/v1/accounts' + suffix)
            .expect(401)
        ).body.errorCode,
      ).toBe('UNAUTHENTICATED');
      expect((await get(expired, suffix).expect(401)).body.errorCode).toBe('TOKEN_EXPIRED');
      for (const role of ['operator', 'auditor', 'admin'] as const) {
        const token = await app.issuer.token(role, { sub: randomUUID() });
        expect((await get(token, suffix).expect(403)).body.errorCode).toBe('FORBIDDEN');
      }
    }
  });

  it('TC-64-06 audit fault withholds list/detail and denial; recovery returns data/404', async () => {
    const user = await customer(1);
    const account = user.accounts[0];
    await q(
      "CREATE FUNCTION dbs64_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$",
    );
    await q(
      'CREATE TRIGGER dbs64_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs64_fail_audit()',
    );
    try {
      for (const suffix of ['', '/' + account.id, '/' + randomUUID()]) {
        const res = await get(user.token, suffix).expect(500);
        expect(res.body.detail).toBe('Internal server error');
        expect(JSON.stringify(res.body)).not.toMatch(/balance|audit unavailable|SELECT|Trần/);
        expect(
          await q(
            "SELECT count(*)::int AS n FROM audit_log WHERE action IN ('account.read','account.list') AND correlation_id=$1",
            [res.headers['x-correlation-id']],
          ),
        ).toEqual([{ n: 0 }]);
      }
    } finally {
      await q('DROP TRIGGER dbs64_fail_audit ON audit_log');
      await q('DROP FUNCTION dbs64_fail_audit()');
    }
    expect((await get(user.token).expect(200)).body).toEqual([account]);
    expect((await get(user.token, '/' + account.id).expect(200)).body).toEqual(account);
    await get(user.token, '/' + randomUUID()).expect(404);
  });

  it('TC-64-07 PostgreSQL bigint projection preserves values above2^53 (not account API roundtrip)', async () => {
    const [{ balance }] = await q('SELECT $1::bigint AS balance', ['9007199254740993']);
    expect(balance).toBe('9007199254740993');
    expect(
      toAccountView({
        id: randomUUID(),
        type: 'CHECKING',
        status: 'ACTIVE',
        balance,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).balance,
    ).toBe('9007199254740993');
    // Actual money DTO mapping is separately unit-tested; no balance rows are fabricated here.
  });

  it('TC-64-08 OpenAPI describes both GET routes, safe DTO and errors', () => {
    const doc = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder()
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
        .build(),
    );
    for (const path of ['/v1/accounts', '/v1/accounts/{id}']) {
      const route = doc.paths[path].get!;
      expect(route.security).toContainEqual({ 'access-token': [] });
      for (const status of ['200', '401', '403', '500', '503'])
        expect(route.responses[status]).toBeDefined();
    }
    expect(doc.paths['/v1/accounts/{id}'].get!.responses['404']).toBeDefined();
    const schema = doc.components!.schemas!.AccountViewDto as {
      properties: Record<string, { type?: string; enum?: string[] }>;
    };
    expect(schema.properties.balance.type).toBe('string');
    expect(schema.properties.status.enum).toEqual(['ACTIVE', 'LOCKED']);
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['id', 'type', 'status', 'balance', 'createdAt', 'updatedAt'].sort(),
    );
  });

  it('TC-64-09 parallel reads keep each owner and correlation audit isolated', async () => {
    const a = await customer(1),
      b = await customer(1);
    const jobs = Array.from({ length: 12 }, (_, i) => ({
      user: i % 2 ? a : b,
      detail: i % 3 === 0,
    }));
    const results = await Promise.all(
      jobs.map(j => get(j.user.token, j.detail ? '/' + j.user.accounts[0].id : '')),
    );
    for (let i = 0; i < jobs.length; i++) {
      const { user, detail } = jobs[i],
        res = results[i];
      expect(res.status).toBe(200);
      expect(res.body).toEqual(detail ? user.accounts[0] : user.accounts);
      const [actor] = await q('SELECT id FROM users WHERE cognito_sub=$1', [user.sub]);
      expect(
        await q(
          'SELECT actor_user_id,outcome FROM audit_log WHERE action=$1 AND correlation_id=$2',
          [detail ? 'account.read' : 'account.list', res.headers['x-correlation-id']],
        ),
      ).toEqual([{ actor_user_id: actor.id, outcome: 'SUCCESS' }]);
    }
  });
});
