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

const TRANSFER_AMOUNT = '100000';
const BASELINE_COUNT = 5;

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

  it('TC-100-01 Redis delay 75ms (>50ms timeout): transfers COMPLETED, rate limit fails open, p95 stays within the two Redis timeouts of the same run (DoD #1)', async () => {
    // Baseline in the same run, with a healthy Redis: a shared CI runner can be slow for reasons that
    // have nothing to do with Redis, so the slow-Redis p95 is compared with this one (DBS-100 review).
    const baseline: number[] = [];
    for (let i = 0; i < BASELINE_COUNT; i += 1) {
      const start = performance.now();
      const res = await executeTransfer(sourceCustomer, targetCustomer, TRANSFER_AMOUNT);
      baseline.push(performance.now() - start);
      expect(res.status).toBe(201);
    }

    const fallbackBefore = await getRedisFallbackCount(app);
    proxy.setDelay(75);

    const count = 20;
    const durations: number[] = [];

    try {
      for (let i = 0; i < count; i += 1) {
        const start = performance.now();
        const res = await executeTransfer(sourceCustomer, targetCustomer, TRANSFER_AMOUNT);
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
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const baselineSorted = baseline.slice().sort((a, b) => a - b);
    const baselineP95 = baselineSorted[Math.floor(baselineSorted.length * 0.95)];

    // Two Redis calls per transfer (IP limit, customer limit), each cut at 50 ms: at most about 100 ms
    // more than the healthy run; 150 ms of margin for a busy runner. Never above the 1 s transfer p99.
    expect(p95).toBeLessThanOrEqual(baselineP95 + 250);
    expect(p95).toBeLessThan(1000);
  });

  const balanceOf = async (accountId: string): Promise<bigint> => {
    const rows = (await db.runner.query('SELECT balance::text FROM accounts WHERE id = $1', [
      accountId,
    ])) as { balance: string }[];
    return BigInt(rows[0].balance);
  };

  it('TC-100-02 Redis outage: transfers continue without blocking, balances updated correctly (DoD #2)', async () => {
    // BL-217: the case reads the balances it starts from (TC-100-01 leaves 25 transfers behind when it
    // ran first, none when this case runs alone with -t) and checks the change, not an absolute value.
    const srcBefore = await balanceOf(sourceCustomer.accountId);
    const dstBefore = await balanceOf(targetCustomer.accountId);
    expect(srcBefore).toBeGreaterThanOrEqual(BigInt('500000'));

    // Shut down proxy to simulate complete Redis outage
    await proxy.stop();

    const transferAmount = '500000';
    const res = await executeTransfer(sourceCustomer, targetCustomer, transferAmount);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('COMPLETED');

    // Verify balances committed to PostgreSQL
    expect(await balanceOf(sourceCustomer.accountId)).toBe(srcBefore - BigInt(transferAmount));
    expect(await balanceOf(targetCustomer.accountId)).toBe(dstBefore + BigInt(transferAmount));
  });

  it('TC-100-03 /health/ready returns 200 OK with redis degraded when Redis is down (DoD #2)', async () => {
    // BL-217: the outage does not depend on TC-100-02 having run first (stop() is idempotent).
    await proxy.stop();
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
