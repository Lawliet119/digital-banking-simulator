// Shared driver for the manual tests of the ledger tasks (DBS-79..83).
// Real NestJS app, real JWT, real PostgreSQL 17 in a Testcontainers container. Users, customers
// and accounts at balance 0 are created by SQL ("SQL INPUT"); every dong enters through the
// operator deposit API. Nothing here prints a token or a credential.
//
//   const { runManual } = require('./lib/ledger-manual-harness.cjs');
//   runManual('DBS-79', async ctx => { ...; ctx.pass('M-79-01', 'what was proven'); });
process.env.NODE_ENV = 'test';
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { Client } = require('pg');
const {
  startPostgresContainer,
  stopPostgresContainer,
} = require('../../test/support/postgres.container');
const { createTempDatabase, migrate } = require('../../test/support/temp-database');
const { startDepositApp, seedDepositTarget } = require('../../test/support/deposit-app');
const { checkLedgerInvariants } = require('../../test/support/invariants');

/** Polls real database state until `condition()` is true; never a fixed sleep. */
async function waitFor(condition, label, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runManual(taskId, steps) {
  console.log(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  let db, app, dbName, containerId;
  let completed = false;
  const jwksDirs = () => readdirSync(tmpdir()).filter(name => name.startsWith('dbs60-jwks-'));
  const jwksBefore = jwksDirs();
  try {
    process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
    db = await createTempDatabase();
    dbName = new URL(db.url).pathname.slice(1);
    containerId = globalThis.__POSTGRES_CONTAINER__?.getId();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    const q = (sql, args = []) => db.runner.query(sql, args);
    const operator = await app.issuer.token('operator', { sub: randomUUID() });
    async function http(path, body, jwt, key = randomUUID(), quiet = false) {
      const res = await fetch(app.url + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: JSON.stringify(body),
      });
      const output = {
        status: res.status,
        correlationId: res.headers.get('x-correlation-id'),
        retryAfter: res.headers.get('retry-after'),
        contentType: res.headers.get('content-type'),
        body: await res.json(),
      };
      if (!quiet)
        console.log(JSON.stringify({ method: 'POST', path, key, request: body, ...output }));
      return output;
    }
    const deposit = (to, amount) =>
      http('/v1/operator/deposits', { toAccountId: to, amount }, operator);
    const transfer = (a, to, amount = '300000', key = randomUUID(), quiet = false) =>
      http(
        '/v1/transfers',
        { fromAccountId: a.accountId, toAccountId: to, amount },
        a.token,
        key,
        quiet,
      );
    async function target(amount = '0', status = 'ACTIVE') {
      const row = await seedDepositTarget(db.runner, status),
        token = await app.issuer.token('customer', { sub: row.sub });
      if (amount !== '0') assert.equal((await deposit(row.accountId, amount)).status, 201);
      return { ...row, token };
    }
    const snapshot = async () =>
      (
        await q(
          `SELECT (SELECT count(*) FROM transfers)::int AS transfers,(SELECT count(*) FROM ledger_entries)::int AS lines,(SELECT count(*) FROM audit_log)::int AS audits,(SELECT count(*) FROM outbox_events)::int AS events,(SELECT count(*) FROM idempotency_keys)::int AS keys,(SELECT jsonb_object_agg(id,balance::text) FROM accounts) AS balances`,
        )
      )[0];
    const balance = async id =>
      (await q('SELECT balance::text AS b FROM accounts WHERE id=$1', [id]))[0].b;
    async function invariant() {
      const report = await checkLedgerInvariants(db.runner);
      assert.equal(report.status, 'PASS');
      assert.equal(report.violations.length, 0);
      console.log(JSON.stringify({ ledgerInvariants: report }));
    }
    console.log(
      'SQL INPUT: users/customers/accounts at migration default ZERO, no SQL balance or ledger seed. ALL funding uses actual deposit HTTP.',
    );
    await steps({
      app,
      db,
      q,
      http,
      deposit,
      transfer,
      target,
      snapshot,
      balance,
      invariant,
      operator,
      waitFor,
      assert,
      randomUUID,
      pass: (id, text) => console.log(`${id} PASS: ${text}`),
    });
    completed = true;
  } finally {
    // Cleanup is observed, not assumed: each check reads the real state back, and a failed check
    // fails the run. The cleanup line is PASS only when every earlier step passed as well.
    const problems = [];
    const attempt = async (label, work) => {
      try {
        await work();
      } catch (error) {
        problems.push(`${label}: ${error.message}`);
      }
    };
    await attempt('close app', async () => {
      await app?.close();
      const leftover = jwksDirs().filter(name => !jwksBefore.includes(name));
      assert.equal(leftover.length, 0, 'temporary JWKS directory still exists');
    });
    await attempt('drop temporary database', async () => {
      await db?.drop();
      if (!dbName) return;
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        const found = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName]);
        assert.equal(found.rowCount, 0, 'temporary database still listed in pg_database');
      } finally {
        await client.end();
      }
    });
    await attempt('stop PostgreSQL container', async () => {
      await stopPostgresContainer();
      if (!containerId) return;
      const left = execFileSync(
        'docker',
        ['ps', '-aq', '--no-trunc', '--filter', `id=${containerId}`],
        { encoding: 'utf8' },
      ).trim();
      assert.equal(left, '', 'owned PostgreSQL container still exists');
    });
    const label = `${taskId} cleanup`;
    if (!completed) {
      console.log(
        `${label} NOT RUN AS PASS: an earlier step failed; cleanup problems: ${problems.join('; ') || 'none'}`,
      );
      process.exitCode = 1;
    } else if (problems.length) {
      console.log(`${label} FAIL: ${problems.join('; ')}`);
      process.exitCode = 1;
    } else {
      console.log(
        `${label} PASS: app closed, JWKS directory gone, temporary database absent from pg_database, owned PG17 container removed`,
      );
    }
  }
}

function main(taskId, steps) {
  runManual(taskId, steps).catch(error => {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runManual: main, waitFor };
