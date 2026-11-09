import { activeTransactionContext } from '@database/transaction.helper';
import {
  createSessionRevocationFixture,
  type SessionRevocationFixture,
} from '../support/session-revocation';

describe('DBS-114 real PostgreSQL / Valkey / JWT / operator lock', () => {
  let f: SessionRevocationFixture;
  beforeAll(async () => {
    f = await createSessionRevocationFixture();
  });
  beforeEach(async () => {
    await f.fresh();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (f) {
      await f.restore();
      await f.invariants();
    }
  });
  afterAll(async () => {
    await f?.close();
  });

  it('TC-114-01 immediate cached revocation uses epoch seconds / TTL and rejects before SQL marker lookup', async () => {
    expect((await f.me()).status).toBe(200);
    const lock = await f.lock();
    expect(lock.status).toBe(200);
    const mark = await f.marker();
    expect(await f.admin.get(f.key())).toBe(String(mark));
    expect(await f.admin.ttl(f.key())).toBeGreaterThan(0);
    expect(await f.admin.ttl(f.key())).toBeLessThanOrEqual(900);
    const source = f.current().source;
    const query = jest.spyOn(source, 'query');
    const response = await f.me();
    f.assertRevoked(response);
    expect(
      query.mock.calls.filter(([sql]) => /SELECT sessions_revoked_at FROM users/.test(sql)),
    ).toHaveLength(0);
  });

  it('TC-114-02 SET occurs only after COMMIT and outside the transaction async context', async () => {
    const locker = f.owner.createQueryRunner();
    await locker.startTransaction();
    const observed: { inside: boolean; visible: number | null; value: string }[] = [];
    const client = f.redis(),
      real = client.set.bind(client);
    jest.spyOn(client, 'set').mockImplementation(async (key, value, ttl) => {
      if (key === f.key())
        observed.push({
          inside: !!activeTransactionContext.getStore(),
          visible: await f.marker(),
          value,
        });
      return real(key, value, ttl);
    });
    let pending: ReturnType<typeof f.lock> | undefined;
    try {
      await locker.query('SELECT 1 FROM accounts WHERE id=$1 FOR UPDATE', [f.actor().accountId]);
      pending = f.lock();
      await f.waitForLock();
      expect(await f.admin.get(f.key())).toBeNull();
      expect((await f.me()).status).toBe(200);
    } finally {
      await locker.rollbackTransaction();
      await locker.release();
    }
    expect((await pending).status).toBe(200);
    expect(observed).toEqual([
      { inside: false, visible: await f.marker(), value: String(await f.marker()) },
    ]);
  });

  it('TC-114-03 audit failure rolls back lock/revocation/outbox without publishing a marker', async () => {
    await f.installAuditFault('rollback');
    const spy = jest.spyOn(f.redis(), 'set');
    expect((await f.lock()).status).toBe(500);
    expect(await f.marker()).toBeNull();
    expect(await f.accountStatus()).toBe('ACTIVE');
    expect(await f.admin.get(f.key())).toBeNull();
    expect(spy.mock.calls.filter(([key]) => key === f.key())).toHaveLength(0);
    expect(await f.effects()).toEqual({ audit: 0, events: 0 });
  });

  it('TC-114-04 cache flush never resurrects a revoked token; SQL repopulates only positive markers', async () => {
    expect(await f.admin.get(f.key())).toBeNull();
    await f.me();
    expect(await f.admin.get(f.key())).toBeNull();
    expect((await f.lock()).status).toBe(200);
    await f.admin.flushDb();
    f.assertRevoked(await f.me());
    expect(await f.admin.get(f.key())).toBe(String(await f.marker()));
  });

  it('TC-114-05 a real slow TCP proxy falls back to PostgreSQL and recovers with a new client', async () => {
    expect((await f.lock()).status).toBe(200);
    const query = jest.spyOn(f.current().source, 'query');
    f.proxy.setDelay(250);
    const started = Date.now();
    f.assertRevoked(await f.me());
    expect(Date.now() - started).toBeLessThan(1500);
    expect(
      query.mock.calls.some(([sql]) => /SELECT sessions_revoked_at FROM users/.test(sql)),
    ).toBe(true);
    f.proxy.setDelay(0);
    const next = await f.second();
    f.assertRevoked(await f.me(next));
    expect(await f.admin.get(f.key())).toBe(String(await f.marker()));
  });

  it('TC-114-06 Redis stopped during lock cannot prevent commit or allow the old token, then recovers', async () => {
    await f.stopRedis();
    const query = jest.spyOn(f.current().source, 'query');
    expect((await f.lock()).status).toBe(200);
    expect(await f.marker()).not.toBeNull();
    f.assertRevoked(await f.me());
    expect(
      query.mock.calls.some(([sql]) => /SELECT sessions_revoked_at FROM users/.test(sql)),
    ).toBe(true);
    await f.startRedis();
    const next = await f.second();
    f.assertRevoked(await f.me(next));
    expect(await f.admin.get(f.key())).toBe(String(await f.marker()));
  });

  it('TC-114-07 a stale valid marker plus real SET failure cannot bypass revocation in a second API', async () => {
    await f.seedOlderRevocation();
    const second = await f.second();
    expect((await f.me(second)).status).toBe(200);
    const old = await f.admin.get(f.key());
    try {
      await f.denySet();
      expect((await f.lock()).status).toBe(200);
      expect(await f.admin.get(f.key())).toBe(old);
      expect(Number(old)).toBeLessThan((await f.marker())!);
      f.assertRevoked(await f.me(second));
    } finally {
      await f.allowSet();
    }
  });

  it('TC-114-08 malformed markers cannot bypass SQL; same-second token stays revoked after unlock', async () => {
    expect((await f.lock()).status).toBe(200);
    const mark = (await f.marker())!;
    const same = await f.token(mark);
    for (const invalid of ['null', 'NaN', '1e9', '999999999999999']) {
      await f.admin.set(f.key(), invalid, { EX: 900 });
      f.assertRevoked(await f.me(undefined, same));
    }
    expect((await f.unlock()).status).toBe(200);
    f.assertRevoked(await f.me(undefined, same));
    const nextToken = await f.token(mark + 1);
    expect((await f.me(undefined, nextToken)).status).toBe(200);
    expect(await f.marker()).toBe(mark);
  });

  it('TC-114-11 serialization retry publishes exactly once from the committed attempt', async () => {
    await f.installAuditFault('retry');
    const client = f.redis(),
      real = client.set.bind(client);
    const writes: { attempt: number; inside: boolean; visible: number | null; value: string }[] =
      [];
    jest.spyOn(client, 'set').mockImplementation(async (key, value, ttl) => {
      if (key === f.key())
        writes.push({
          attempt: await f.attempts(),
          inside: !!activeTransactionContext.getStore(),
          visible: await f.marker(),
          value,
        });
      return real(key, value, ttl);
    });
    expect((await f.lock()).status).toBe(200);
    expect(await f.attempts()).toBe(2);
    expect(writes).toEqual([
      { attempt: 2, inside: false, visible: await f.marker(), value: String(await f.marker()) },
    ]);
    expect(await f.effects()).toEqual({ audit: 1, events: 1 });
  });

  it('TC-114-12 revoking one user never revokes or caches a null mark for another', async () => {
    const other = await f.otherCustomer();
    expect((await f.me(undefined, other.token)).status).toBe(200);
    expect((await f.lock()).status).toBe(200);
    f.assertRevoked(await f.me());
    expect((await f.me(undefined, other.token)).status).toBe(200);
    expect(await f.admin.get(`revoked_at:${other.userId}`)).toBeNull();
    expect(await f.admin.get(f.key())).toBe(String(await f.marker()));
  });
});
