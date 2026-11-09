// DBS-119 manual test: PostgreSQL 17 least-privilege roles, migrator guard and append-only trigger enforcement
// Runs real migrations, proves dbs_api, dbs_worker, dbs_migrator ACL matrix and defense-in-depth triggers.
const { resolve } = require('node:path');
process.chdir(resolve(__dirname, '..'));
process.env.NODE_ENV = 'test';
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DataSource } = require('typeorm');
const {
  startPostgresContainer,
  stopPostgresContainer,
} = require('../test/support/postgres.container');
const { createTempDatabase, migrate } = require('../test/support/temp-database');
const { startDepositApp, seedDepositTarget } = require('../test/support/deposit-app');
const { checkLedgerInvariants } = require('../test/support/invariants');
const {
  CreateDbRolesAndGrants1793664000000,
} = require('../src/database/migrations/1793664000000-CreateDbRolesAndGrants');

const pass = (id, text) => console.log(`${id} PASS: ${text}`);

async function main() {
  console.log(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  console.log(
    'DBS-119 manual verification: PostgreSQL 17 least-privilege roles, migrator guard and append-only trigger enforcement',
  );

  let db, app, apiSource, workerSource, migratorSource;
  const PASSWORD = 'role-test-only';

  const urlFor = role => {
    const u = new URL(db.url);
    u.username = role;
    u.password = PASSWORD;
    return u.toString();
  };

  const connect = async role =>
    new DataSource({
      type: 'postgres',
      url: urlFor(role),
    }).initialize();

  try {
    process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
    db = await createTempDatabase();

    // M-119-01: Run migration step 7, verify 3 roles, view ownership, idempotency and down/up lifecycle
    await migrate(db.url);

    const roles = await db.runner.query(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('dbs_migrator', 'dbs_api', 'dbs_worker') ORDER BY rolname",
    );
    assert.deepEqual(
      roles.map(r => r.rolname),
      ['dbs_api', 'dbs_migrator', 'dbs_worker'],
    );

    const [{ viewowner: initialOwner }] = await db.runner.query(
      "SELECT viewowner FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_transfer_facts'",
    );
    assert.equal(initialOwner, 'dbs_migrator');

    // Idempotency check: run up() again directly
    const step7 = new CreateDbRolesAndGrants1793664000000();
    await step7.up(db.runner);

    // Revert check: undoLast
    await migrate(db.url, 'undoLast');
    const [{ viewowner: revertedOwner }] = await db.runner.query(
      "SELECT viewowner FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_transfer_facts'",
    );
    assert.notEqual(revertedOwner, 'dbs_migrator');

    // Re-apply check: up
    await migrate(db.url, 'up');
    const [{ viewowner: reappliedOwner }] = await db.runner.query(
      "SELECT viewowner FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_transfer_facts'",
    );
    assert.equal(reappliedOwner, 'dbs_migrator');

    pass(
      'M-119-01',
      '3 roles exist, v_transfer_facts owned by dbs_migrator, migration step 7 is idempotent and lifecycle down/up is clean',
    );

    // Prepare credentials for connection testing
    for (const role of ['dbs_api', 'dbs_worker', 'dbs_migrator']) {
      await db.runner.query(`ALTER ROLE ${role} LOGIN PASSWORD '${PASSWORD}'`);
    }
    apiSource = await connect('dbs_api');
    workerSource = await connect('dbs_worker');
    migratorSource = await connect('dbs_migrator');

    // M-119-02: Real API flows run as dbs_api, append-only mutations denied with 42501, invariants pass
    app = await startDepositApp(urlFor('dbs_api'));
    const a = await seedDepositTarget(db.runner);
    const b = await seedDepositTarget(db.runner);
    const operatorToken = await app.issuer.token('operator', { sub: randomUUID() });
    const customerToken = await app.issuer.token('customer', { sub: a.sub });

    // Deposit 5,000,000
    const depRes = await fetch(`${app.url}/v1/operator/deposits`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorToken}`,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ toAccountId: a.accountId, amount: '5000000' }),
    });
    assert.equal(depRes.status, 201);

    // Transfer 1,500,000
    const transferKey = randomUUID();
    const sendTransfer = () =>
      fetch(`${app.url}/v1/transfers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken}`,
          'Idempotency-Key': transferKey,
        },
        body: JSON.stringify({
          fromAccountId: a.accountId,
          toAccountId: b.accountId,
          amount: '1500000',
        }),
      });

    const txRes1 = await sendTransfer();
    assert.equal(txRes1.status, 201);
    const txBody1 = await txRes1.json();

    // Idempotency replay
    const txRes2 = await sendTransfer();
    assert.equal(txRes2.status, 201);
    const txBody2 = await txRes2.json();
    assert.deepEqual(txBody1, txBody2);

    // Unauthorized mutations by dbs_api
    let deniedCount = 0;
    try {
      await apiSource.query('UPDATE ledger_entries SET amount = amount');
    } catch (e) {
      assert.match(e.message, /permission denied/);
      deniedCount++;
    }
    try {
      await apiSource.query('DELETE FROM transfers');
    } catch (e) {
      assert.match(e.message, /permission denied/);
      deniedCount++;
    }
    assert.equal(deniedCount, 2);

    const invariants = await checkLedgerInvariants(db.runner);
    assert.equal(invariants.status, 'PASS');

    pass(
      'M-119-02',
      'API flows run as dbs_api (deposit 5M, transfer 1.5M, replay 201), unauthorized mutations denied (42501), ledger invariants PASS',
    );

    // M-119-03: dbs_worker reads v_transfer_facts, blocked from transfers table
    const viewRows = await workerSource.query(
      'SELECT id, amount, status FROM v_transfer_facts WHERE amount = 1500000',
    );
    assert.ok(viewRows.length >= 1);
    assert.equal(viewRows[0].status, 'COMPLETED');

    let directDenied = false;
    try {
      await workerSource.query('SELECT * FROM transfers');
    } catch (e) {
      assert.match(e.message, /permission denied/);
      directDenied = true;
    }
    assert.ok(directDenied);

    pass(
      'M-119-03',
      'dbs_worker reads transfer facts via v_transfer_facts without SELECT permissions on transfers table (BL-005)',
    );

    // M-119-04: dbs_migrator has DDL privileges, protected by forbid_mutation trigger; app blocks dbs_migrator
    await migratorSource.query(
      'CREATE TABLE public.dbs_manual_migrator_test (id int PRIMARY KEY, val text)',
    );
    await migratorSource.query(
      "INSERT INTO public.dbs_manual_migrator_test VALUES (1, 'migrator-ddl')",
    );
    const testRows = await migratorSource.query('SELECT * FROM public.dbs_manual_migrator_test');
    assert.equal(testRows.length, 1);
    await migratorSource.query('DROP TABLE public.dbs_manual_migrator_test');

    let triggerFired = false;
    try {
      await migratorSource.query('UPDATE public.ledger_entries SET amount = amount');
    } catch (e) {
      assert.match(e.message, /append-only/);
      assert.equal(e.driverError?.code, '42501');
      triggerFired = true;
    }
    assert.ok(triggerFired);

    let guardTriggered = false;
    try {
      await startDepositApp(urlFor('dbs_migrator'));
    } catch (e) {
      assert.match(e.message, /dbs_migrator/);
      guardTriggered = true;
    }
    assert.ok(guardTriggered);

    pass(
      'M-119-04',
      'dbs_migrator has DDL privileges but append-only tables guarded by forbid_mutation (AC-8.1); app startup with dbs_migrator blocked (DoD #2)',
    );
  } finally {
    const cleanupErrors = [];
    try {
      await app?.close();
    } catch (e) {
      cleanupErrors.push(e.message);
    }
    try {
      await apiSource?.destroy();
    } catch (e) {
      cleanupErrors.push(e.message);
    }
    try {
      await workerSource?.destroy();
    } catch (e) {
      cleanupErrors.push(e.message);
    }
    try {
      await migratorSource?.destroy();
    } catch (e) {
      cleanupErrors.push(e.message);
    }
    try {
      await db?.drop();
    } catch (e) {
      cleanupErrors.push(e.message);
    }
    try {
      await stopPostgresContainer();
    } catch (e) {
      cleanupErrors.push(e.message);
    }

    if (cleanupErrors.length) {
      console.log(`DBS-119 cleanup FAIL: ${cleanupErrors.join('; ')}`);
      process.exitCode = 1;
    } else {
      pass(
        'M-119-cleanup',
        'app closed, database connections released, temporary database dropped, container stopped',
      );
    }
  }
}

main().catch(err => {
  console.error(`${err.name}: ${err.message}\n${err.stack || ''}`);
  process.exitCode = 1;
});
