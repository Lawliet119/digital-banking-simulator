import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { RateLimitMetrics, RateLimiter } from '@common/rate-limit';
import { RedisClient, RedisMetrics } from '@libs/redis';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { startLatencyProxy } from '../support/latency-proxy';
import { startPostgresContainer, stopPostgresContainer } from '../support/postgres.container';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';
import { expectLedgerInvariantsAfterEach } from '../support/ledger-invariants';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type Row = Awaited<ReturnType<typeof seedDepositTarget>>;
type Proxy = Awaited<ReturnType<typeof startLatencyProxy>>;
interface Clocked {
  clock: { now: () => Date };
}

/**
 * DBS-89 on the real thing: the real guards in the real request pipeline, PostgreSQL 17 and
 * Valkey 8 in containers, a TCP proxy that can slow Valkey down, and a stopped container for
 * "dead". Every test lives in a minute of its own (the limiter's clock is fixed), so counters
 * never leak from one test into the next on the one shared IP 127.0.0.1.
 */
describe('DBS-89 rate limit against Valkey and PostgreSQL', () => {
  let valkey: StartedValkey, proxy: Proxy, db: TempDatabase;
  let operator: string;
  const apps: App[] = [];
  const BASE = Date.UTC(2026, 2, 15, 3, 0, 0); // 15 Mar 2026 03:00:00Z, minute boundary
  let nextMinute = 0;
  /** A minute nobody has used: the limiter's clock stands at its :20 second. */
  function freshMinute(app: App): number {
    const minute = BASE + nextMinute++ * 60_000;
    const limiter = app.app.get<RateLimiter, Clocked>(RateLimiter);
    jest.spyOn(limiter.clock, 'now').mockReturnValue(new Date(minute + 20_000));
    return minute;
  }
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

  async function start(options: { trustProxyHops?: number } = {}): Promise<App> {
    const app = await startDepositApp(db.url, {
      rateLimit: {
        redisUrl: proxy.url,
        trustProxyHops: options.trustProxyHops,
        requestsPerIpPerMinute: 1000,
        transfersPerMinute: 1000,
      },
    });
    apps.push(app);
    const redis = app.app.get(RedisClient);
    const deadline = Date.now() + 5000;
    while (!redis.isReady) {
      if (Date.now() > deadline) throw new Error('Valkey did not become ready');
      await wait(10);
    }
    return app;
  }
  const deposit = (app: App, to: string, amount: string) =>
    request(app.url)
      .post('/v1/operator/deposits')
      .auth(operator, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: to, amount });
  async function funded(app: App, amount = '1000000'): Promise<Row> {
    const row = await seedDepositTarget(db.runner);
    expect((await deposit(app, row.accountId, amount)).status).toBe(201);
    return row;
  }
  const transfer = async (app: App, from: Row, to: Row, amount = '1000', key = randomUUID()) =>
    request(app.url)
      .post('/v1/transfers')
      .auth(await app.issuer.token('customer', { sub: from.sub }), { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ fromAccountId: from.accountId, toAccountId: to.accountId, amount });
  const counts = async () =>
    (
      await q(
        `SELECT (SELECT count(*) FROM transfers)::int AS transfers,
                (SELECT count(*) FROM idempotency_keys)::int AS keys,
                (SELECT count(*) FROM audit_log)::int AS audits,
                (SELECT count(*) FROM outbox_events)::int AS events`,
      )
    )[0] as Record<string, number>;
  const probe = (app: App, headers: Record<string, string> = {}) =>
    request(app.url).get('/v1/identity/me').set(headers); // no token: 401, and it is counted

  beforeAll(async () => {
    process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
    valkey = await startValkeyContainer();
    proxy = await startLatencyProxy(valkey.host, valkey.port);
    db = await createTempDatabase();
    await migrate(db.url);
  }, 600_000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    for (const app of apps) await app.close().catch(() => undefined);
    await db?.drop().catch(() => undefined);
    await proxy?.stop().catch(() => undefined);
    await valkey?.stop().catch(() => undefined);
    await stopPostgresContainer();
  }, 120_000);

  expectLedgerInvariantsAfterEach(() => db?.runner);

  describe('TRUST_PROXY_HOPS = 0 (no proxy in front)', () => {
    let app: App;
    beforeAll(async () => {
      app = await start();
      operator = await app.issuer.token('operator', { sub: randomUUID() });
    });

    it('TC-89-05 the 101st request of a minute from one IP is 429 RATE_LIMITED with Retry-After', async () => {
      app.limits.rateLimit.requestsPerIpPerMinute = 5;
      const limited = await app.app.get(RateLimitMetrics).count('ip');
      freshMinute(app); // 03:..:20 -> 40 seconds left in the minute
      for (let i = 0; i < 4; i++) expect((await probe(app)).status).toBe(401); // no token, counted
      expect((await request(app.url).get('/v1/no-such-route')).status).toBe(404); // counted: 5th
      const sixth = await probe(app);
      expect(sixth.status).toBe(429);
      expect(sixth.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(sixth.headers['retry-after']).toBe('40');
      expect(sixth.body).toMatchObject({
        status: 429,
        errorCode: 'RATE_LIMITED',
        correlationId: expect.any(String),
      });
      // A refused request still counts: the flood does not get cheaper by being refused.
      expect((await probe(app)).status).toBe(429);
      expect(await app.app.get(RateLimitMetrics).count('ip')).toBe(limited + 2);
      // The next minute starts a new count.
      jest.restoreAllMocks();
      freshMinute(app);
      expect((await probe(app)).status).toBe(401);
    });

    it('TC-89-06 the 11th transfer request of a customer in a minute is 429 and writes nothing', async () => {
      app.limits.rateLimit.requestsPerIpPerMinute = 1000;
      app.limits.rateLimit.transfersPerMinute = 3;
      const giang = await funded(app),
        hai = await funded(app, '1000'),
        khanh = await funded(app);
      const minute = freshMinute(app);
      const firstKey = randomUUID();
      expect((await transfer(app, giang, hai, '1000', firstKey)).status).toBe(201);
      expect((await transfer(app, giang, hai)).status).toBe(201);
      expect((await transfer(app, giang, hai)).status).toBe(201);
      const before = await counts();
      const fourth = await transfer(app, giang, hai);
      expect(fourth.status).toBe(429);
      expect(fourth.headers['retry-after']).toBe('40');
      expect(fourth.body.errorCode).toBe('RATE_LIMITED');
      // Even the replay of an earlier request is refused: the limit is about abuse.
      expect((await transfer(app, giang, hai, '1000', firstKey)).status).toBe(429);
      expect(await counts()).toEqual(before); // no transfer, key, audit row or event
      // Another customer has a count of their own.
      expect((await transfer(app, khanh, hai)).status).toBe(201);
      // And the next minute is free again for Giang. It is the minute right after `minute`, so the
      // counter of whichever test comes next must not be it: take two minutes, use the later one.
      jest.restoreAllMocks();
      const following = freshMinute(app);
      expect(following).toBe(minute + 60_000);
      nextMinute += 1; // keep a minute of distance to the next test
      expect((await transfer(app, giang, hai)).status).toBe(201);
      app.limits.rateLimit.transfersPerMinute = 1000;
    });

    it('TC-89-07 /health is never part of the IP limit', async () => {
      app.limits.rateLimit.requestsPerIpPerMinute = 5;
      freshMinute(app);
      for (let i = 0; i < 10; i++) {
        expect((await request(app.url).get('/health/live')).status).toBe(200);
      }
      expect((await request(app.url).get('/health/ready')).status).toBe(200);
      // None of them was counted: the business routes still have their five.
      for (let i = 0; i < 5; i++) expect((await probe(app)).status).toBe(401);
      expect((await probe(app)).status).toBe(429);
    });

    it('TC-89-08 hops=0: a forged X-Forwarded-For cannot buy a fresh count', async () => {
      app.limits.rateLimit.requestsPerIpPerMinute = 2;
      freshMinute(app);
      expect((await probe(app, { 'X-Forwarded-For': '1.1.1.1' })).status).toBe(401);
      expect((await probe(app, { 'X-Forwarded-For': '2.2.2.2' })).status).toBe(401);
      expect((await probe(app, { 'X-Forwarded-For': '3.3.3.3' })).status).toBe(429);
      expect((await probe(app, { 'X-Forwarded-For': '4.4.4.4, 5.5.5.5' })).status).toBe(429);
    });

    it('TC-89-12 Swagger documents the 429 of a transfer', () => {
      const doc = SwaggerModule.createDocument(
        app.app,
        new DocumentBuilder()
          .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
          .build(),
      );
      expect(doc.paths['/v1/transfers'].post!.responses['429']).toBeDefined();
    });

    it('TC-89-10 slow Redis (250 ms, timeout 50 ms): requests pass, fallback is counted, nothing waits long', async () => {
      app.limits.rateLimit.requestsPerIpPerMinute = 1; // the second request would be 429 if Redis answered
      freshMinute(app);
      const metrics = app.app.get(RedisMetrics);
      const before = await metrics.count();
      proxy.setDelay(250);
      try {
        for (let i = 0; i < 3; i++) {
          const started = Date.now();
          const res = await probe(app);
          expect(res.status).toBe(401); // not 429: the limit was skipped
          expect(Date.now() - started).toBeLessThan(1500);
        }
      } finally {
        proxy.setDelay(0);
      }
      expect(await metrics.count()).toBeGreaterThan(before);
    });

    it('TC-89-11 once Redis answers again the limit holds again', async () => {
      app.limits.rateLimit.requestsPerIpPerMinute = 1;
      freshMinute(app);
      const redis = app.app.get(RedisClient);
      // The slow phase may have opened the breaker (5 s); wait for it, then the limit must bite.
      const deadline = Date.now() + 20_000;
      let refused = false;
      while (!refused && Date.now() < deadline) {
        refused = (await probe(app)).status === 429;
        if (!refused) await wait(250);
      }
      expect(refused).toBe(true);
      expect(redis.circuitState).toBe('closed');
    }, 60_000);
  });

  describe('TRUST_PROXY_HOPS = 1 (behind the ALB)', () => {
    let app: App;
    beforeAll(async () => {
      app = await start({ trustProxyHops: 1 });
    });

    it('TC-89-08 hops=1: the client is the address on the right of X-Forwarded-For', async () => {
      app.limits.rateLimit.requestsPerIpPerMinute = 2;
      freshMinute(app);
      const via = (client: string, forged = '198.51.100.1') => ({
        'X-Forwarded-For': `${forged}, ${client}`,
      });
      expect((await probe(app, via('192.0.2.10'))).status).toBe(401);
      expect((await probe(app, via('192.0.2.10'))).status).toBe(401);
      expect((await probe(app, via('192.0.2.10'))).status).toBe(429);
      // A different forged value on the left is the same client: still refused.
      expect((await probe(app, via('192.0.2.10', '198.51.100.99'))).status).toBe(429);
      // Another client behind the same ALB has a count of its own.
      expect((await probe(app, via('192.0.2.11'))).status).toBe(401);
      expect((await probe(app, via('192.0.2.11'))).status).toBe(401);
      expect((await probe(app, via('192.0.2.11'))).status).toBe(429);
      // IPv4 written as IPv6 is the same client.
      expect((await probe(app, { 'X-Forwarded-For': '::ffff:192.0.2.10' })).status).toBe(429);
    });
  });

  describe('Redis stopped', () => {
    let app: App;
    beforeAll(async () => {
      app = await start();
      operator = await app.issuer.token('operator', { sub: randomUUID() });
    });

    it('TC-89-09 dead Redis: nothing is limited, money still moves, fallback is counted', async () => {
      const giang = await funded(app),
        hai = await seedDepositTarget(db.runner);
      app.limits.rateLimit.requestsPerIpPerMinute = 1;
      app.limits.rateLimit.transfersPerMinute = 1;
      freshMinute(app);
      const redis = app.app.get(RedisClient);
      const metrics = app.app.get(RedisMetrics);
      await valkey.stop();
      const deadline = Date.now() + 10_000;
      while (redis.isReady && Date.now() < deadline) await wait(25);
      expect(redis.isReady).toBe(false);
      const before = await metrics.count();
      for (let i = 0; i < 3; i++) expect((await probe(app)).status).toBe(401);
      for (let i = 0; i < 3; i++) expect((await transfer(app, giang, hai)).status).toBe(201);
      expect(await metrics.count()).toBeGreaterThan(before);
      const ready = await request(app.url).get('/health/ready').expect(200);
      expect(ready.body.redis).toBe('degraded');
    }, 60_000);
  });
});
