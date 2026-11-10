import request from 'supertest';
import {
  createSessionRevocationFixture,
  type SessionRevocationFixture,
} from '../support/session-revocation';

describe('DBS-186 committed lock survives Redis data loss and outage', () => {
  let f: SessionRevocationFixture;
  const stamp = async () => {
    const [row] = await f.owner.query<{ stamp: string }[]>(
      'SELECT sessions_revoked_at::text AS stamp FROM users WHERE id=$1',
      [f.actor().userId],
    );
    return row.stamp;
  };
  const observeSql = () => {
    const spy = jest.spyOn(f.current().source, 'query');
    return () =>
      spy.mock.calls.filter(([sql]) => /SELECT sessions_revoked_at FROM users/.test(sql)).length;
  };

  beforeAll(async () => {
    f = await createSessionRevocationFixture();
  });
  beforeEach(async () => {
    await f.fresh();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (f) {
      try {
        await f.invariants();
      } finally {
        await f.restore();
      }
    }
  });
  afterAll(async () => {
    await f?.close();
  });

  it.each(['flush', 'down'] as const)(
    'TC-186-01/02 lock commits before Redis %s; the very next request reads SQL and refuses the session',
    async mode => {
      const other = await f.otherCustomer();
      expect((await f.me()).status).toBe(200);
      expect((await f.lock()).status).toBe(200);
      const before = await stamp();
      const mark = await f.marker();
      expect(mark).not.toBeNull();
      expect(await f.admin.get(f.key())).toBe(String(mark));
      const reads = observeSql();

      if (mode === 'flush') {
        await f.admin.flushDb();
        expect(await f.admin.ping()).toBe('PONG');
        expect(await f.admin.get(f.key())).toBeNull();
      } else {
        await f.stopRedis();
      }
      // No request by A is allowed between the fault and this assertion (AC-11.1).
      f.assertRevoked(await f.me());
      expect(reads()).toBe(1);
      expect(await stamp()).toBe(before);
      expect(await f.accountStatus()).toBe('LOCKED');
      expect(await f.effects()).toEqual({ audit: 1, events: 1 });
      expect((await f.me(undefined, other.token)).status).toBe(200);
      if (mode === 'down') {
        await f.startRedis();
        const recovered = await f.second();
        f.assertRevoked(await f.me(recovered));
      }
      expect(await f.admin.get(f.key())).toBe(String(mark));
      expect(await stamp()).toBe(before);
    },
  );

  it.each(['hit', 'flush', 'down'] as const)(
    'TC-186-03 %s: equal-second token is revoked and next-second token reaches another ACTIVE account of the same owner',
    async mode => {
      const app = f.current();
      const oldToken = await f.token(f.actor().issuedAt);
      const opened = await request(app.url)
        .post('/v1/accounts')
        .auth(oldToken, { type: 'bearer' })
        .send({ type: 'SAVINGS' })
        .expect(201);
      expect((await f.lock()).status).toBe(200);
      const mark = (await f.marker())!;
      const before = await stamp();
      expect(await f.admin.get(f.key())).toBe(String(mark));
      const reads = observeSql();
      if (mode === 'down') await f.stopRedis();

      for (const delta of [0, 1]) {
        if (mode === 'flush') {
          await f.admin.flushDb();
          expect(await f.admin.ping()).toBe('PONG');
          expect(await f.admin.get(f.key())).toBeNull();
        }
        const token = await app.issuer.token('customer', {
          sub: f.actor().sub,
          iat: mark + delta,
          exp: Math.floor(Date.now() / 1000) + 900,
        });
        const count = reads();
        const response = await request(app.url)
          .get(`/v1/accounts/${opened.body.id as string}`)
          .auth(token, { type: 'bearer' });
        if (delta === 0) {
          expect(response.status).toBe(401);
          expect(response.body.errorCode).toBe('SESSION_REVOKED');
          expect(response.body.correlationId).toBe(response.headers['x-correlation-id']);
          expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
        } else {
          expect(response.status).toBe(200);
          expect(response.body).toMatchObject({ id: opened.body.id, status: 'ACTIVE' });
        }
        expect(reads() - count).toBe(mode === 'hit' && delta === 0 ? 0 : 1);
        expect(await stamp()).toBe(before);
        expect(await f.accountStatus()).toBe('LOCKED');
      }
    },
  );
});
