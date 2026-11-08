// DBS-89 manual test: the rate limit on the real app, with a real JWT, PostgreSQL 17 and Valkey 8
// in containers. 10 transfers a minute per customer is the production default; the per-IP limit is
// lowered to 20 for the step that reaches it (it is 1000 before, so that setting up customers and
// sending ten transfers never meets it). Users, customers and accounts are SQL INPUT;
// the money enters through the deposit API.
process.env.NODE_ENV = 'test';
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');
const { execFileSync } = require('node:child_process');
const {
  startPostgresContainer,
  stopPostgresContainer,
} = require('../test/support/postgres.container');
const { startValkeyContainer } = require('../test/support/valkey.container');
const { createTempDatabase, migrate } = require('../test/support/temp-database');
const { startDepositApp, seedDepositTarget } = require('../test/support/deposit-app');
const { RedisClient, RedisMetrics } = require('../src/libs/redis');

const pass = (id, text) => console.log(`${id} PASS: ${text}`);

async function main() {
  console.log(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  let valkey, db, app;
  let completed = false;
  try {
    process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
    valkey = await startValkeyContainer();
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, {
      rateLimit: { redisUrl: valkey.url, requestsPerIpPerMinute: 1000, transfersPerMinute: 10 },
    });
    const redis = app.app.get(RedisClient);
    const metrics = app.app.get(RedisMetrics);
    for (let i = 0; i < 200 && !redis.isReady; i++) await wait(25);
    assert.ok(redis.isReady, 'Valkey is ready');
    const q = (sql, args = []) => db.runner.query(sql, args);
    const operator = await app.issuer.token('operator', { sub: randomUUID() });
    const call = async (method, path, { token, body, key, headers } = {}) => {
      const res = await fetch(app.url + path, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: res.status, retryAfter: res.headers.get('retry-after'), body: parsed };
    };
    const person = async (amount = '0') => {
      const row = await seedDepositTarget(db.runner);
      const token = await app.issuer.token('customer', { sub: row.sub });
      if (amount !== '0') {
        const dep = await call('POST', '/v1/operator/deposits', {
          token: operator,
          key: randomUUID(),
          body: { toAccountId: row.accountId, amount },
        });
        assert.equal(dep.status, 201);
      }
      return { ...row, token };
    };
    const send = (from, to, amount = '1000') =>
      call('POST', '/v1/transfers', {
        token: from.token,
        key: randomUUID(),
        body: { fromAccountId: from.accountId, toAccountId: to.accountId, amount },
      });
    const counts = async () =>
      (
        await q(
          'SELECT (SELECT count(*) FROM transfers)::int AS transfers, (SELECT count(*) FROM audit_log)::int AS audits',
        )
      )[0];
    // The IP limit (20) is shared by every step on this machine: wait for a fresh minute when a
    // step needs the whole budget.
    const freshMinute = async () => {
      const left = 60_000 - (Date.now() % 60_000);
      if (left < 25_000) {
        console.log(`(waiting ${Math.ceil(left / 1000)} s for a new minute)`);
        await wait(left + 200);
      }
    };

    // M-89-01 / M-89-02 / M-89-03 per-customer limit
    await freshMinute();
    const giang = await person('10000000'),
      hai = await person(),
      ha = await person('1000000');
    for (let i = 0; i < 10; i++) {
      const res = await send(giang, hai);
      assert.equal(res.status, 201, `transfer ${i + 1}`);
    }
    pass('M-89-01', 'Vũ Thị Giang sent 10 transfers of 1,000 to Bùi Văn Hải in a minute: 10 x 201');
    const before = await counts();
    const eleventh = await send(giang, hai);
    console.log(
      JSON.stringify({
        step: 'M-89-02',
        status: eleventh.status,
        retryAfter: eleventh.retryAfter,
        body: eleventh.body,
      }),
    );
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.body.errorCode, 'RATE_LIMITED');
    assert.ok(Number(eleventh.retryAfter) >= 1 && Number(eleventh.retryAfter) <= 60);
    assert.deepEqual(await counts(), before, 'a refused transfer wrote nothing');
    pass(
      'M-89-02',
      `the 11th: 429 RATE_LIMITED, Retry-After ${eleventh.retryAfter} s, no transfer or audit row written`,
    );
    const other = await send(ha, hai);
    assert.equal(other.status, 201);
    pass('M-89-03', 'Trần Thu Hà transferred in the same minute: 201 (her count is her own)');

    // M-89-04 per-IP limit; health is never counted. Start at the first second of a minute so that
    // the count of this IP is empty.
    app.limits.rateLimit.requestsPerIpPerMinute = 20;
    await wait(60_000 - (Date.now() % 60_000) + 300);
    let first429 = 0;
    for (let i = 1; i <= 25; i++) {
      const res = await call('GET', '/v1/identity/me');
      if (res.status === 429 && !first429) {
        first429 = i;
        console.log(
          JSON.stringify({
            step: 'M-89-04',
            request: i,
            status: res.status,
            retryAfter: res.retryAfter,
            body: res.body,
          }),
        );
      }
    }
    assert.equal(first429, 21, 'the 21st request of the minute is the first refused');
    for (let i = 0; i < 10; i++) assert.equal((await call('GET', '/health/live')).status, 200);
    pass(
      'M-89-04',
      `no token needed to be counted: requests 1-20 of the minute were 401, the first 429 came at request ${first429} of 25 (limit 20); 10 x /health/live all 200`,
    );

    // M-89-05 dead Redis
    const fallbackBefore = await metrics.count();
    await valkey.stop();
    for (let i = 0; i < 200 && redis.isReady; i++) await wait(25);
    assert.equal(redis.isReady, false);
    for (let i = 0; i < 30; i++) {
      const res = await call('GET', '/v1/identity/me');
      assert.equal(res.status, 401, `request ${i + 1} with Redis stopped`);
    }
    for (let i = 0; i < 12; i++) assert.equal((await send(giang, hai)).status, 201);
    const fallbackAfter = await metrics.count();
    assert.ok(fallbackAfter > fallbackBefore);
    console.log(`redis_fallback_total ${fallbackBefore} -> ${fallbackAfter}`);
    pass(
      'M-89-05',
      `Valkey stopped: 30 unauthenticated requests and 12 transfers by one customer (limit 10) all went through; redis_fallback_total ${fallbackBefore} -> ${fallbackAfter}`,
    );
    completed = true;
  } finally {
    const problems = [];
    const attempt = async (label, work) => {
      try {
        await work();
      } catch (error) {
        problems.push(`${label}: ${error.message}`);
      }
    };
    await attempt('close app', async () => app?.close());
    await attempt('drop temporary database', async () => db?.drop());
    await attempt('stop Valkey', async () => valkey?.stop());
    await attempt('stop PostgreSQL', async () => stopPostgresContainer());
    if (!completed) {
      console.log(
        `DBS-89 cleanup NOT RUN AS PASS: an earlier step failed; cleanup problems: ${problems.join('; ') || 'none'}`,
      );
      process.exitCode = 1;
    } else if (problems.length) {
      console.log(`DBS-89 cleanup FAIL: ${problems.join('; ')}`);
      process.exitCode = 1;
    } else {
      console.log(
        'DBS-89 cleanup PASS: app closed, temporary database dropped, Valkey and PostgreSQL containers removed',
      );
    }
  }
}

main().catch(error => {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
});
