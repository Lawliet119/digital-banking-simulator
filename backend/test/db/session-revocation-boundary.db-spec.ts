import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { checkLedgerInvariants } from '../support/invariants';
import { startDepositApp } from '../support/deposit-app';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

describe('DBS-115 same-second revocation through real JWT, HTTP and PostgreSQL', () => {
  let db: TempDatabase;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  let operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const get = (id: string, token: string) =>
    request(app.url).get(`/v1/accounts/${id}`).auth(token, { type: 'bearer' });

  async function customer() {
    const sub = randomUUID();
    const token = await app.issuer.token('customer', { sub });
    await request(app.url)
      .post('/v1/customers/me')
      .auth(token, { type: 'bearer' })
      .send({ fullName: 'Nguyễn Minh Anh' })
      .expect(200);
    const accounts: string[] = [];
    for (const type of ['CHECKING', 'SAVINGS']) {
      const response = await request(app.url)
        .post('/v1/accounts')
        .auth(token, { type: 'bearer' })
        .send({ type })
        .expect(201);
      accounts.push(response.body.id as string);
    }
    const [{ id: userId }] = await q('SELECT id FROM users WHERE cognito_sub=$1', [sub]);
    return { sub, userId: userId as string, a: accounts[0], b: accounts[1], token };
  }

  async function boundary(sub: string, accountId: string, seconds: number) {
    // Controlled signed claims test the comparison, not Cognito issuance or the wall clock.
    const exp = Math.floor(Date.now() / 1000) + 900;
    expect(exp).toBeGreaterThan(seconds + 1);
    const same = await app.issuer.token('customer', { sub, iat: seconds, exp });
    const next = await app.issuer.token('customer', { sub, iat: seconds + 1, exp });
    const refused = await get(accountId, same).expect(401);
    expect(refused.body).toMatchObject({ status: 401, errorCode: 'SESSION_REVOKED' });
    expect(refused.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(refused.body.correlationId).toBe(refused.headers['x-correlation-id']);
    const allowed = await get(accountId, next).expect(200);
    expect(allowed.body).toMatchObject({ id: accountId, status: 'ACTIVE', balance: '0' });
    expect(allowed.body).not.toHaveProperty('reason');
    expect(allowed.body).not.toHaveProperty('fraudFlags');
  }

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    operator = await app.issuer.token('operator', { sub: randomUUID() });
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

  it('TC-115-01 rejects iat equal to the committed lock second and accepts the next second on another ACTIVE account of the same owner', async () => {
    const user = await customer();
    await get(user.b, user.token).expect(200);
    const locked = await request(app.url)
      .post(`/v1/operator/accounts/${user.a}/lock`)
      .auth(operator, { type: 'bearer' })
      .send({ reason: 'CONFIRMED_FRAUD' })
      .expect(200);
    const [{ seconds, mark }] = await q(
      'SELECT floor(extract(epoch FROM sessions_revoked_at))::bigint::text AS seconds, sessions_revoked_at::text AS mark FROM users WHERE id=$1',
      [user.userId],
    );
    expect(
      await q('SELECT outcome FROM audit_log WHERE correlation_id=$1', [
        locked.headers['x-correlation-id'],
      ]),
    ).toEqual([{ outcome: 'SUCCESS' }]);
    expect(
      await q(
        "SELECT event_type FROM outbox_events WHERE aggregate_id=$1 AND event_type='AccountStatusChanged'",
        [user.a],
      ),
    ).toEqual([{ event_type: 'AccountStatusChanged' }]);
    await boundary(user.sub, user.b, Number(seconds));
    expect(
      await q('SELECT id,status FROM accounts WHERE id IN ($1,$2) ORDER BY id', [user.a, user.b]),
    ).toEqual(
      [
        { id: user.a, status: 'LOCKED' },
        { id: user.b, status: 'ACTIVE' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(
      (await q('SELECT sessions_revoked_at::text AS mark FROM users WHERE id=$1', [user.userId]))[0]
        .mark,
    ).toBe(mark);
  });

  it.each(['000000', '001000', '999999'])(
    'TC-115-02 uses floor with PostgreSQL microseconds .%s: same second401, next second200',
    async fraction => {
      const user = await customer();
      const [{ base }] = await q(
        "SELECT to_char(date_trunc('second', clock_timestamp()) - interval '10 seconds', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS base",
      );
      // Auth-state INPUT only in our temporary database. No money or ledger SQL seed.
      const marker = `${base}.${fraction}Z`;
      await q('UPDATE users SET sessions_revoked_at=$2::timestamptz WHERE id=$1', [
        user.userId,
        marker,
      ]);
      const [{ seconds, micros }] = await q(
        "SELECT floor(extract(epoch FROM sessions_revoked_at))::bigint::text AS seconds, to_char(sessions_revoked_at, 'US') AS micros FROM users WHERE id=$1",
        [user.userId],
      );
      expect(micros).toBe(fraction);
      await boundary(user.sub, user.b, Number(seconds));
    },
  );
});
