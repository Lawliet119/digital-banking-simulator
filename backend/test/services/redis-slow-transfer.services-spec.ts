import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { register as defaultRegister } from 'prom-client';
import request from 'supertest';
import { RedisClient, RedisMetrics } from '@libs/redis';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';
import { startLatencyProxy } from '../support/latency-proxy';
import { startPostgresContainer, stopPostgresContainer } from '../support/postgres.container';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type TargetAccount = Awaited<ReturnType<typeof seedDepositTarget>> & { token: string };
type Proxy = Awaited<ReturnType<typeof startLatencyProxy>>;

async function getRedisFallbackCount(appInstance: App): Promise<number> {
  try {
    const redisMetrics = appInstance.app.get(RedisMetrics);
    if (redisMetrics) return await redisMetrics.count();
  } catch {
    // fallback to defaultRegister
  }
  const metric = defaultRegister.getSingleMetric('redis_fallback_total');
  const value = (await metric?.get())?.values[0]?.value;
  return typeof value === 'number' ? value : 0;
}

describe('DBS-100 Review Focus 5: Redis slow or dead during customer transfers', () => {
  let valkey: StartedValkey;
  let proxy: Proxy;
  let db: TempDatabase;
  let app: App;
  let operatorToken: string;
  let sourceCustomer: TargetAccount;
  let targetCustomer: TargetAccount;

  const depositToAccount = (toAccountId: string, amount: string) =>
    request(app.url)
      .post('/v1/operator/deposits')
      .auth(operatorToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId, amount });

  const executeTransfer = (
    from: TargetAccount,
    to: TargetAccount,
    amount: string,
    key = randomUUID(),
  ) =>
    request(app.url)
      .post('/v1/transfers')
      .auth(from.token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ fromAccountId: from.accountId, toAccountId: to.accountId, amount });

  beforeAll(async () => {
    process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
    valkey = await startValkeyContainer();
    proxy = await startLatencyProxy(valkey.host, valkey.port);
    db = await createTempDatabase();
    await migrate(db.url);

    app = await startDepositApp(db.url, {
      rateLimit: {
        redisUrl: proxy.url,
        requestsPerIpPerMinute: 1000,
        transfersPerMinute: 1000,
      },
    });

    const redis = app.app.get(RedisClient);
    const deadline = Date.now() + 5000;
    while (!redis.isReady) {
      if (Date.now() > deadline) throw new Error('Valkey did not become ready');
      await wait(10);
    }

    operatorToken = await app.issuer.token('operator', { sub: randomUUID() });

    const srcRow = await seedDepositTarget(db.runner);
    const srcToken = await app.issuer.token('customer', { sub: srcRow.sub });
    sourceCustomer = { ...srcRow, token: srcToken };

    const dstRow = await seedDepositTarget(db.runner);
    const dstToken = await app.issuer.token('customer', { sub: dstRow.sub });
    targetCustomer = { ...dstRow, token: dstToken };

    // Fund source account with 100,000,000 VND
    const depositRes = await depositToAccount(sourceCustomer.accountId, '100000000');
    expect(depositRes.status).toBe(201);
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      try {
        await proxy?.stop();
      } finally {
        try {
          await valkey?.stop();
        } finally {
          try {
            await db?.drop();
          } finally {
            await stopPostgresContainer();
          }
        }
      }
    }
  }, 120_000);

  it('TC-100-01 Redis delay 75ms (>50ms timeout): transfers COMPLETED, rate limit fails open, p95 <= 250ms (DoD #1)', async () => {
    const fallbackBefore = await getRedisFallbackCount(app);
    proxy.setDelay(75);

    const count = 20;
    const durations: number[] = [];

    try {
      for (let i = 0; i < count; i += 1) {
        const start = performance.now();
        const res = await executeTransfer(sourceCustomer, targetCustomer, '100000');
        const elapsed = performance.now() - start;

        expect(res.status).toBe(201);
        expect(res.body.status).toBe('COMPLETED');
        durations.push(elapsed);
      }
    } finally {
      proxy.setDelay(0);
    }

    // Verify rate limit failed open: all 20 transfers succeeded
    expect(durations).toHaveLength(count);

    // Verify fallback counter increased due to timeouts
    const fallbackAfter = await getRedisFallbackCount(app);
    expect(fallbackAfter).toBeGreaterThan(fallbackBefore);

    // Calculate p95 latency
    const sorted = durations.slice().sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p95 = sorted[p95Index];

    expect(p95).toBeLessThanOrEqual(250);
  });

  it('TC-100-02 Redis outage: transfers continue without blocking, balances updated correctly (DoD #2)', async () => {
    // Shut down proxy to simulate complete Redis outage
    await proxy.stop();

    const transferAmount = '500000';
    const res = await executeTransfer(sourceCustomer, targetCustomer, transferAmount);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('COMPLETED');

    // Verify balances committed to PostgreSQL
    const srcRow = (await db.runner.query('SELECT balance::text FROM accounts WHERE id = $1', [
      sourceCustomer.accountId,
    ])) as { balance: string }[];
    const dstRow = (await db.runner.query('SELECT balance::text FROM accounts WHERE id = $1', [
      targetCustomer.accountId,
    ])) as { balance: string }[];

    // 100M initial - (20 * 100k) from TC-100-01 - 500k from TC-100-02 = 97,500,000 VND
    expect(srcRow[0].balance).toBe('97500000');
    // 0 initial + (20 * 100k) + 500k = 2,500,000 VND
    expect(dstRow[0].balance).toBe('2500000');
  });

  it('TC-100-03 /health/ready returns 200 OK with redis degraded when Redis is down (DoD #2)', async () => {
    const res = await request(app.url).get('/health/ready').expect(200);

    expect(res.body).toMatchObject({
      status: 'ok',
      redis: 'degraded',
      details: {
        database: { status: 'up' },
      },
    });

    // Liveness remains 200 OK
    await request(app.url).get('/health/live').expect(200, { status: 'ok' });
  });

  it('TC-100-04 verifies all 5 ledger invariants PASS after all tests (DoD #3)', async () => {
    const report = await checkLedgerInvariants(db.runner);
    expect(report.status).toBe('PASS');
    expect(report.violations).toHaveLength(0);
    expect(report.totals.balance).toBe('0');
    expect(BigInt(report.totals.debit)).toBe(BigInt(report.totals.credit));
  });
});
