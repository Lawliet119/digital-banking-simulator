// Real reads and preliminary HTTP latency measurement on an owned disposable PostgreSQL17.
process.env.NODE_ENV = 'test';
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const {
  startPostgresContainer,
  stopPostgresContainer,
} = require('../test/support/postgres.container');
const { createTempDatabase, migrate } = require('../test/support/temp-database');
const { startOnboardingApp } = require('../test/support/onboarding-app');
const { checkLedgerInvariants } = require('../test/support/invariants');

async function main() {
  console.log(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  console.log(
    JSON.stringify({
      environment: {
        node: process.version,
        database: 'PostgreSQL17 Docker local',
        http: '127.0.0.1, real JWT + read/audit transaction',
        concurrency: 1,
        accountsPerOwner: 3,
        cache: 'no Redis dependency in query service',
      },
    }),
  );
  let db, app;
  try {
    process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startOnboardingApp(db.url);
    const q = (sql, args = []) => db.runner.query(sql, args);
    const http = async (method, path, token, body, quiet = false) => {
      const response = await fetch(app.url + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = {
        status: response.status,
        correlationId: response.headers.get('x-correlation-id'),
        body: await response.json(),
      };
      if (!quiet) console.log(JSON.stringify({ method, path, ...result }));
      return result;
    };
    const customer = async (name, count = 0, onboard = true) => {
      const sub = randomUUID(),
        token = await app.issuer.token('customer', { sub });
      if (onboard)
        assert.equal(
          (await http('POST', '/v1/customers/me', token, { fullName: name })).status,
          200,
        );
      const accounts = [];
      for (let i = 0; i < count; i++) {
        const res = await http('POST', '/v1/accounts', token, {
          type: i % 2 ? 'SAVINGS' : 'CHECKING',
        });
        assert.equal(res.status, 201);
        accounts.push(res.body);
      }
      return { sub, token, accounts };
    };
    const invariants = async () => {
      const report = await checkLedgerInvariants(db.runner);
      assert.equal(report.status, 'PASS');
      console.log(JSON.stringify({ ledgerInvariants: report }));
    };
    const a = await customer('Nguyễn Minh Anh', 3);
    const listed = await http('GET', '/v1/accounts', a.token);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 3);
    const detailPath = '/v1/accounts/' + a.accounts[0].id;
    const detail = await http('GET', detailPath, a.token);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body, a.accounts[0]);
    for (const account of listed.body) assert.equal(account.balance, '0');
    for (const res of [listed, detail])
      assert.deepEqual(
        await q('SELECT outcome FROM audit_log WHERE correlation_id=$1', [res.correlationId]),
        [{ outcome: 'SUCCESS' }],
      );
    await invariants();
    console.log(
      'M-64-01 PASS: own list3/detail200, exact zero strings, SUCCESS audits, invariants PASS',
    );

    const b = await customer('Trần Thu Hà', 1);
    assert.deepEqual((await http('GET', '/v1/accounts', b.token)).body, b.accounts);
    for (const id of [
      a.accounts[0].id,
      '00000000-0000-4000-8000-000000000001',
      randomUUID(),
      'invalid-account',
    ]) {
      const res = await http('GET', '/v1/accounts/' + id, b.token);
      assert.equal(res.status, 404);
      assert.deepEqual(
        await q("SELECT outcome FROM audit_log WHERE action='account.read' AND correlation_id=$1", [
          res.correlationId,
        ]),
        [{ outcome: 'DENIED' }],
      );
    }
    assert.equal((await http('GET', '/v1/accounts', undefined)).status, 401);
    const operator = await app.issuer.token('operator', { sub: randomUUID() });
    assert.equal((await http('GET', detailPath, operator)).status, 403);
    console.log(
      'M-64-02 PASS: isolated owners; foreign/SYSTEM/missing/malformed404 with DENIED;401/403',
    );

    const empty = await customer('Phạm Ngọc Lan');
    assert.deepEqual((await http('GET', '/v1/accounts?userId=' + a.sub, empty.token)).body, []);
    const unonboarded = await customer('Lê Hoàng Nam', 0, false);
    assert.deepEqual((await http('GET', '/v1/accounts', unonboarded.token)).body, []);
    await q("UPDATE accounts SET status='LOCKED' WHERE id=$1", [a.accounts[0].id]);
    assert.equal((await http('GET', detailPath, a.token)).body.status, 'LOCKED');
    await invariants();
    console.log(
      'M-64-03 PASS: empty/unonboarded[], forged selector ignored, fresh committed LOCKED status visible',
    );

    await q(
      "CREATE FUNCTION dbs64_manual_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$",
    );
    await q(
      'CREATE TRIGGER dbs64_manual_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs64_manual_fail()',
    );
    try {
      for (const path of ['/v1/accounts', detailPath]) {
        const res = await http('GET', path, a.token);
        assert.equal(res.status, 500);
        assert.equal(res.body.detail, 'Internal server error');
        assert.ok(!JSON.stringify(res.body).includes('balance'));
      }
    } finally {
      await q('DROP TRIGGER dbs64_manual_fail ON audit_log');
      await q('DROP FUNCTION dbs64_manual_fail()');
    }
    assert.equal((await http('GET', detailPath, a.token)).status, 200);
    await invariants();
    console.log(
      'M-64-04 PASS: actual audit fault returns sanitized500/no balance; recovery200, invariants PASS',
    );

    let latencyPass = true;
    for (const path of ['/v1/accounts', detailPath]) {
      for (let i = 0; i < 10; i++)
        assert.equal((await http('GET', path, a.token, undefined, true)).status, 200);
      const samplesMs = [];
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        const res = await http('GET', path, a.token, undefined, true);
        const elapsed = performance.now() - start;
        assert.equal(res.status, 200);
        samplesMs.push(elapsed);
      }
      const sorted = [...samplesMs].sort((x, y) => x - y),
        p95Ms = sorted[Math.ceil(0.95 * sorted.length) - 1];
      const met = p95Ms < 150;
      latencyPass &&= met;
      console.log(
        JSON.stringify({
          benchmark: {
            path,
            warmup: 10,
            count: 100,
            concurrency: 1,
            includes: 'HTTP + JWT + PostgreSQL read/audit commit + JSON response',
            p95Method: 'nearest rank',
            p95Ms,
            thresholdMs: 150,
            met,
            samplesMs,
          },
        }),
      );
    }
    assert.ok(
      latencyPass,
      'Measured read p95 exceeds150ms; inspect actual samples, do not claim target met',
    );
    await invariants();
    console.log(
      'M-64-05 PASS: both measured HTTP read p95<150ms,100 real samples per route after10 warmups',
    );
    console.log(
      'LIMITATION: nonzero/above2^53 balance HTTP roundtrip not run: actual deposit API pending; no SQL balance seed or fake ledger',
    );
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await db?.drop();
      } finally {
        await stopPostgresContainer();
      }
    }
    console.log('M-64-06 PASS: app/JWKS/temp DB/owned PostgreSQL17 cleaned up');
  }
}
main().catch(error => {
  console.error(error.name + ': ' + error.message);
  process.exitCode = 1;
});
