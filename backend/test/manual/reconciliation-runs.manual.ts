import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { createTempDatabase, type TempDatabase } from '../support/temp-database';
import { createMigrationDataSource } from '@database/data-source';
import { startPostgresContainer, stopPostgresContainer } from '../support/postgres.container';

type Row = Record<string, unknown>;
const TARGET = 'CreateReconciliationRuns1793577600000';
const backend = resolve(__dirname, '../..');
const root = resolve(backend, '..');
const npm =
  process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const codePaths = [
  'backend/src/database/migrations/1793577600000-CreateReconciliationRuns.ts',
  'backend/test/db/reconciliation-schema.db-spec.ts',
  'backend/test/db/reconciliation-migration-revert.db-spec.ts',
  'backend/test/db/append-only.db-spec.ts',
  'backend/test/manual/append-only.manual.ts',
  'backend/test/dev-auth-bootstrap.e2e-spec.ts',
  'backend/test/manual/reconciliation-runs.manual.ts',
];
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const START = '2026-11-03T01:00:00Z';
const redact = (text: string) =>
  text.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, '[redacted connection]');
const log = (label: string, data?: unknown) =>
  console.log(label, data === undefined ? '' : JSON.stringify(data));
function errorInfo(error: unknown) {
  const e = (error !== null && typeof error === 'object' ? error : {}) as {
    name?: string;
    code?: string;
    driverError?: { code?: string; constraint?: string };
  };
  return {
    name: e.name,
    code: e.driverError?.code ?? e.code,
    constraint: e.driverError?.constraint,
  };
}
async function sql(db: TempDatabase, text: string, parameters: unknown[] = []): Promise<Row[]> {
  log(`SQL> ${text}`, parameters);
  const rows: Row[] = await db.runner.query(text, parameters);
  log('RESULT', rows);
  return rows;
}
function cli(db: TempDatabase, script: string, shouldFail = false) {
  log(`$ npm run ${script}`, { database: db.name });
  const result = spawnSync(process.execPath, [npm, 'run', script], {
    cwd: backend,
    env: { ...process.env, DATABASE_URL: db.url },
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  console.log(redact(result.stdout ?? ''));
  console.log(redact(result.stderr ?? ''));
  if (result.error)
    throw Object.assign(new Error('Migration CLI failed to finish'), errorInfo(result.error));
  assert.equal(result.signal, null);
  if (shouldFail) assert.notEqual(result.status, 0);
  else assert.equal(result.status, 0);
  log('CLI EXIT', result.status);
}
async function history(db: TempDatabase) {
  return sql(db, 'SELECT name,timestamp FROM migrations ORDER BY timestamp,id');
}
async function catalog(db: TempDatabase) {
  return {
    columns: await sql(
      db,
      "SELECT column_name,data_type,is_nullable,column_default,is_identity,identity_generation FROM information_schema.columns WHERE table_schema='public' AND table_name='reconciliation_runs' ORDER BY ordinal_position",
    ),
    constraints: await sql(
      db,
      "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass('public.reconciliation_runs') ORDER BY conname",
    ),
    sequence: await sql(
      db,
      "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' AND sequencename='reconciliation_runs_id_seq'",
    ),
    history: await history(db),
    funding: await sql(db, 'SELECT id,type,balance FROM accounts ORDER BY id'),
  };
}
async function expectRefused(
  db: TempDatabase,
  text: string,
  parameters: unknown[],
  constraint: string,
) {
  const before = await sql(db, 'SELECT count(*)::text AS count FROM reconciliation_runs');
  let refusal: ReturnType<typeof errorInfo> | undefined;
  try {
    await sql(db, text, parameters);
  } catch (error) {
    refusal = errorInfo(error);
  }
  log('EXPECTED REJECTION', refusal);
  assert.equal(refusal?.code, '23514');
  assert.equal(refusal.constraint, constraint);
  assert.deepEqual(
    await sql(db, 'SELECT count(*)::text AS count FROM reconciliation_runs'),
    before,
  );
}

async function main() {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--', ...codePaths], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const hash = createHash('sha256');
  for (const path of codePaths)
    hash
      .update(path)
      .update('\0')
      .update(readFileSync(resolve(root, path)));
  const snapshot = hash.digest('hex');
  console.log(
    dirty
      ? `WORKING_TREE base=${sha} snapshot=${snapshot}; preliminary only, NOT final-SHA evidence`
      : execFileSync('git', ['log', '-1', '--format=%H', '--', ...codePaths], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
  );
  const previous = new Map(['NODE_ENV', 'DATABASE_URL'].map(key => [key, process.env[key]]));
  const databases = new Set<TempDatabase>();
  const names: string[] = [];
  let server: DataSource | undefined;
  let ownContainer = false;
  async function temporary() {
    const db = await createTempDatabase();
    databases.add(db);
    names.push(db.name);
    log('TEMP DATABASE', db.name);
    return db;
  }
  async function race(commit: boolean) {
    const step = commit ? 'M-116-07' : 'M-116-08';
    log(`MANUAL STEP ${step}`, { writerCommits: commit });
    const db = await temporary();
    cli(db, 'migration:run');
    const beforeHistory = await history(db);
    assert.equal(beforeHistory.at(-1)?.name, TARGET);
    const source = await createMigrationDataSource(db.url).initialize();
    let pending: Promise<unknown> | undefined;
    try {
      await db.runner.startTransaction('READ COMMITTED');
      const [{ pid: writerPid }] = await sql(db, 'SELECT pg_backend_pid() AS pid');
      await sql(
        db,
        "INSERT INTO reconciliation_runs(started_at,status) VALUES($1,'OK') RETURNING id",
        [START],
      );
      log('$ TypeORM undoLastMigration', { database: db.name, transaction: 'all' });
      pending = source.undoLastMigration({ transaction: 'all' }).then(
        () => null,
        (error: unknown) => error,
      );
      const deadline = Date.now() + 10000;
      let waiter: Row | undefined;
      while (Date.now() < deadline) {
        const rows: Row[] = await source.query(
          "SELECT pid,wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'LOCK TABLE public.reconciliation_runs%'",
          [db.name],
        );
        if (rows.length === 1) {
          waiter = rows[0];
          break;
        }
      }
      log('LOCK OBSERVED', waiter);
      assert(waiter, 'Revert must wait for the writer relation lock');
      assert.deepEqual(waiter.blockers, [writerPid]);
      if (commit) {
        await db.runner.commitTransaction();
        log('WRITER COMMIT');
      } else {
        await db.runner.rollbackTransaction();
        log('WRITER ROLLBACK');
      }
      const result = await pending;
      if (commit) {
        log('REVERT REFUSED', errorInfo(result));
        assert.equal(errorInfo(result).code, '55000');
        assert.equal((await sql(db, 'SELECT * FROM reconciliation_runs')).length, 1);
        assert.deepEqual(await history(db), beforeHistory);
      } else {
        assert.equal(result, null);
        assert.deepEqual(
          await sql(db, "SELECT to_regclass('public.reconciliation_runs') AS name"),
          [{ name: null }],
        );
        assert.deepEqual(await history(db), beforeHistory.slice(0, -1));
        cli(db, 'migration:run');
        assert.deepEqual(await sql(db, 'SELECT * FROM reconciliation_runs'), []);
        assert.deepEqual(await history(db), beforeHistory);
      }
      log(`MANUAL STEP PASS ${step}`);
    } finally {
      if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
      if (pending) await pending;
      await source.destroy();
    }
  }
  try {
    process.env.NODE_ENV = 'test';
    // A private server prevents a supplied development URL ever receiving this driver's DDL.
    const fixture = await startPostgresContainer();
    ownContainer = true;
    process.env.DATABASE_URL = fixture.databaseUrl;
    server = await new DataSource({ type: 'postgres', url: fixture.databaseUrl }).initialize();
    const db = await temporary();

    log('MANUAL STEP M-116-01 environment and CLI run twice');
    const [{ version, timezone }] = await sql(
      db,
      "SELECT current_setting('server_version') AS version,current_setting('timezone') AS timezone",
    );
    assert.match(String(version), /^17\./);
    assert.equal(timezone, 'UTC');
    cli(db, 'migration:run');
    const initialHistory = await history(db);
    assert.equal(initialHistory.at(-1)?.name, TARGET);
    cli(db, 'migration:run');
    assert.deepEqual(await history(db), initialHistory);
    log('MANUAL STEP PASS M-116-01');

    log('MANUAL STEP M-116-02 empty revert/run and catalog');
    const before = await catalog(db);
    cli(db, 'migration:revert');
    assert.deepEqual(
      await sql(
        db,
        "SELECT to_regclass('public.reconciliation_runs') AS table_name,to_regclass('public.reconciliation_runs_id_seq') AS sequence_name",
      ),
      [{ table_name: null, sequence_name: null }],
    );
    assert.deepEqual(await history(db), initialHistory.slice(0, -1));
    cli(db, 'migration:run');
    const restored = await catalog(db);
    assert.deepEqual(restored, before);
    assert.equal(restored.columns.length, 9);
    assert.deepEqual(
      restored.constraints.map(row => row.conname),
      [
        'reconciliation_runs_details_check',
        'reconciliation_runs_pkey',
        'reconciliation_runs_status_check',
      ],
    );
    log('MANUAL STEP PASS M-116-02');

    log('MANUAL STEP M-116-03 seed SQL valid OK/MISMATCH/ERROR');
    const ok = await sql(
      db,
      "INSERT INTO reconciliation_runs(started_at,finished_at,status,total_debit,total_credit,total_balance) VALUES($1,$2,'OK','0','0','0') RETURNING *",
      [START, '2026-11-03T01:00:01Z'],
    );
    assert.equal(ok[0].mismatched_accounts, 0);
    const details = [{ accountId: ACCOUNT, balance: '700000', ledgerBalance: '600000' }];
    const mismatch = await sql(
      db,
      "INSERT INTO reconciliation_runs(started_at,finished_at,status,total_debit,total_credit,total_balance,mismatched_accounts,details) VALUES($1,$2,'MISMATCH','600000','600000','0',1,$3::jsonb) RETURNING *",
      [START, '2026-11-03T01:00:01Z', JSON.stringify(details)],
    );
    assert.deepEqual(mismatch[0].details, details);
    const error = await sql(
      db,
      "INSERT INTO reconciliation_runs(started_at,status,details) VALUES($1,'ERROR','[]'::jsonb) RETURNING *",
      [START],
    );
    assert.equal(error[0].finished_at, null);
    assert.equal(error[0].total_debit, null);
    assert.deepEqual(error[0].details, []);
    log('MANUAL STEP PASS M-116-03');

    log('MANUAL STEP M-116-04 exact money above2^53 and signed bigint boundaries');
    const extremes = [
      { accountId: ACCOUNT, balance: '9007199254740993', ledgerBalance: '-9223372036854775808' },
      {
        accountId: '22222222-2222-4222-8222-222222222222',
        balance: '9223372036854775807',
        ledgerBalance: '0',
      },
    ];
    const precise = await sql(
      db,
      "INSERT INTO reconciliation_runs(started_at,status,total_debit,total_credit,total_balance,mismatched_accounts,details) VALUES($1,'MISMATCH',$2,$3,$4,2,$5::jsonb) RETURNING *",
      [
        START,
        '9007199254740993',
        '9223372036854775807',
        '-9223372036854775808',
        JSON.stringify(extremes),
      ],
    );
    assert.equal(precise[0].total_debit, '9007199254740993');
    assert.equal(precise[0].total_credit, '9223372036854775807');
    assert.equal(precise[0].total_balance, '-9223372036854775808');
    assert.deepEqual(precise[0].details, extremes);
    log('MANUAL STEP PASS M-116-04');

    log('MANUAL STEP M-116-05 rejected status/PII shape/missing key/number/-0/overflow');
    await expectRefused(
      db,
      'INSERT INTO reconciliation_runs(started_at,status) VALUES($1,$2)',
      [START, 'RUNNING'],
      'reconciliation_runs_status_check',
    );
    const base = { accountId: ACCOUNT, balance: '700000', ledgerBalance: '600000' };
    for (const payload of [
      [{ ...base, email: 'rejected-fixture' }],
      [{ accountId: ACCOUNT, balance: '1' }],
      [{ ...base, balance: 1 }],
      [{ ...base, balance: '-0' }],
      [{ ...base, balance: '9223372036854775808' }],
    ]) {
      await expectRefused(
        db,
        "INSERT INTO reconciliation_runs(started_at,status,details) VALUES($1,'MISMATCH',$2::jsonb)",
        [START, JSON.stringify(payload)],
        'reconciliation_runs_details_check',
      );
    }
    log('MANUAL STEP PASS M-116-05');

    log('MANUAL STEP M-116-06 populated revert must keep every row and catalog');
    const populated = {
      catalog: await catalog(db),
      rows: await sql(db, 'SELECT * FROM reconciliation_runs ORDER BY id'),
    };
    cli(db, 'migration:revert', true);
    const source = await createMigrationDataSource(db.url).initialize();
    let refusal: ReturnType<typeof errorInfo> | undefined;
    try {
      await source.undoLastMigration({ transaction: 'all' });
    } catch (caught) {
      refusal = errorInfo(caught);
    } finally {
      await source.destroy();
    }
    log('EXPECTED REVERT REJECTION', refusal);
    assert.equal(refusal?.code, '55000');
    assert.deepEqual(
      {
        catalog: await catalog(db),
        rows: await sql(db, 'SELECT * FROM reconciliation_runs ORDER BY id'),
      },
      populated,
    );
    cli(db, 'migration:run');
    log('MANUAL STEP PASS M-116-06');
    await race(true);
    await race(false);
  } finally {
    try {
      log('MANUAL STEP M-116-09 cleanup owned temporary databases');
      for (const db of databases) {
        if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
        await db.drop();
        log('DROPPED TEMP DATABASE', db.name);
      }
      if (server) {
        const remaining: Row[] = await server.query(
          'SELECT datname FROM pg_database WHERE datname=ANY($1::text[])',
          [names],
        );
        log('CLEANUP RESULT', remaining);
        assert.deepEqual(remaining, []);
      }
      log('MANUAL STEP PASS M-116-09');
    } finally {
      if (server?.isInitialized) await server.destroy();
      if (ownContainer) await stopPostgresContainer();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
  log('ALL RECONCILIATION MANUAL STEPS PASS M-116-01..09', { snapshot });
}

main().catch((error: unknown) => {
  log('RECONCILIATION MANUAL FAILED', errorInfo(error));
  process.exitCode = 1;
});
