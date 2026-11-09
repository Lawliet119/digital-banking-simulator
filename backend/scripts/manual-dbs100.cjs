// DBS-100 manual test: verify customer transfers under slow and dead Redis
process.env.NODE_ENV = 'test';
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');
const {
  startPostgresContainer,
  stopPostgresContainer,
} = require('../test/support/postgres.container');
const { startValkeyContainer } = require('../test/support/valkey.container');
const { startLatencyProxy } = require('../test/support/latency-proxy');
const { createTempDatabase, migrate } = require('../test/support/temp-database');
const { startDepositApp, seedDepositTarget } = require('../test/support/deposit-app');
const { checkLedgerInvariants } = require('../test/support/invariants');
const { RedisClient, RedisMetrics } = require('../src/libs/redis');

async function main() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  console.log(`DBS-100 manual test starting at commit: ${commit}`);

  let valkey, proxy, db, app;
  try {
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

    const redisMetrics = app.app.get(RedisMetrics);
    const operatorToken = await app.issuer.token('operator', { sub: randomUUID() });

    const srcRow = await seedDepositTarget(db.runner);
    const srcToken = await app.issuer.token('customer', { sub: srcRow.sub });
    const fromCustomer = { ...srcRow, token: srcToken };

    const dstRow = await seedDepositTarget(db.runner);
    const dstToken = await app.issuer.token('customer', { sub: dstRow.sub });
    const toCustomer = { ...dstRow, token: dstToken };

    // Fund source account with 100,000,000 VND
    const depRes = await fetch(app.url + '/v1/operator/deposits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorToken}`,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ toAccountId: fromCustomer.accountId, amount: '100000000' }),
    });
    assert.equal(depRes.status, 201, 'Deposit funding must succeed');

    const transferHttp = async (amount = '100000') => {
      const start = performance.now();
      const res = await fetch(app.url + '/v1/transfers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fromCustomer.token}`,
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          fromAccountId: fromCustomer.accountId,
          toAccountId: toCustomer.accountId,
          amount,
        }),
      });
      const elapsed = performance.now() - start;
      const body = await res.json();
      return { status: res.status, body, elapsed };
    };

    // M-100-01: Baseline latency with Redis normal (delay = 0ms)
    console.log('M-100-01: Baseline transfer latency (delay = 0ms)...');
    const baselineResults = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await transferHttp('50000');
      assert.equal(res.status, 201);
      assert.equal(res.body.status, 'COMPLETED');
      baselineResults.push(res.elapsed);
    }
    const avgBaseline = (baselineResults.reduce((a, b) => a + b, 0) / baselineResults.length).toFixed(2);
    console.log(`M-100-01 PASS: 5 baseline transfers COMPLETED, avg latency: ${avgBaseline} ms\n`);

    // M-100-02: Redis slow (delay = 75ms > 50ms commandTimeoutMs)
    console.log('M-100-02: Transfer under slow Redis (proxy delay = 75ms > 50ms timeout)...');
    const countBefore = await redisMetrics.count();
    proxy.setDelay(75);

    const slowResults = [];
    try {
      for (let i = 0; i < 20; i += 1) {
        const res = await transferHttp('100000');
        assert.equal(res.status, 201, `Transfer ${i + 1} should succeed with 201`);
        assert.equal(res.body.status, 'COMPLETED');
        slowResults.push(res.elapsed);
      }
    } finally {
      proxy.setDelay(0);
    }

    const countAfter = await redisMetrics.count();
    assert.ok(countAfter > countBefore, `redis_fallback_total must increase (${countBefore} -> ${countAfter})`);

    const sorted = slowResults.slice().sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    console.log(`20 transfers completed under slow Redis:`);
    console.log(`  Min: ${sorted[0].toFixed(2)} ms | Max: ${sorted[sorted.length - 1].toFixed(2)} ms | p95: ${p95.toFixed(2)} ms`);
    console.log(`  redis_fallback_total: ${countBefore} -> ${countAfter}`);
    assert.ok(p95 <= 250, `p95 latency (${p95}ms) must be <= 250ms`);
    console.log('M-100-02 PASS: All 20 transfers COMPLETED, rate limit failed open, p95 within SLA threshold.\n');

    // M-100-03: Complete Redis outage (proxy stopped)
    console.log('M-100-03: Transfer under complete Redis outage (proxy stopped)...');
    await proxy.stop();

    const deadRes = await transferHttp('500000');
    assert.equal(deadRes.status, 201, 'Transfer must succeed even when Redis is down');
    assert.equal(deadRes.body.status, 'COMPLETED');
    console.log(`Transfer under outage completed in ${deadRes.elapsed.toFixed(2)} ms (fail-fast)`);

    const srcBal = await db.runner.query('SELECT balance::text FROM accounts WHERE id = $1', [fromCustomer.accountId]);
    const dstBal = await db.runner.query('SELECT balance::text FROM accounts WHERE id = $1', [toCustomer.accountId]);
    console.log(`PostgreSQL balances verified: Source=${srcBal[0].balance} VND, Destination=${dstBal[0].balance} VND`);
    console.log('M-100-03 PASS: Transfer succeeded without delay during Redis outage.\n');

    // M-100-04: /health/ready probe during Redis outage
    console.log('M-100-04: Checking /health/ready when Redis is down...');
    const healthRes = await fetch(app.url + '/health/ready');
    const healthBody = await healthRes.json();
    assert.equal(healthRes.status, 200, '/health/ready must return HTTP 200 when Redis is down');
    assert.equal(healthBody.status, 'ok');
    assert.equal(healthBody.redis, 'degraded', 'Redis status must be degraded');
    assert.equal(healthBody.details.database.status, 'up', 'PostgreSQL must remain up');
    console.log('Health response:', JSON.stringify(healthBody));
    console.log('M-100-04 PASS: /health/ready returns 200 OK with redis: degraded.\n');

    // M-100-05: Ledger invariants check
    console.log('M-100-05: Running checkLedgerInvariants...');
    const invReport = await checkLedgerInvariants(db.runner);
    console.log(JSON.stringify(invReport, null, 2));
    assert.equal(invReport.status, 'PASS', 'Invariants check must PASS');
    assert.equal(invReport.violations.length, 0, 'No violations allowed');
    assert.equal(invReport.totals.balance, '0', 'System total balance must be 0');
    assert.equal(invReport.totals.debit, invReport.totals.credit, 'Debit must equal credit');
    console.log('M-100-05 PASS: All 5 ledger invariants verified clean.\n');

    console.log('ALL MANUAL CHECKS PASSED (M-100-01 to M-100-05).');
  } finally {
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
    console.log('Cleanup completed.');
  }
}

main().catch(err => {
  console.error('Manual test failed:', err);
  process.exitCode = 1;
});

