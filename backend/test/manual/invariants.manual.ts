import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { getErrorCode } from '@common/utils/pg-error.util';
import { checkLedgerInvariants } from '../support/invariants';
import {
  INVARIANT_FUNDING_ID,
  invariantState,
  postInvariantTransfer,
  seedInvariantAccounts,
  seedInvariantLedger,
} from '../support/invariant-fixtures';
import { startPostgresContainer, stopPostgresContainer } from '../support/postgres.container';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

const backend = resolve(__dirname, '../..');
const root = resolve(backend, '..');
const cliFile = resolve(backend, 'test/support/invariants.ts');
const codePaths = [
  'backend/package.json',
  'backend/test/db/invariants.db-spec.ts',
  'backend/test/support/invariant-fixtures.ts',
  'backend/test/support/invariants.ts',
  'backend/test/support/invariants.sql',
  'backend/test/manual/invariants.manual.ts',
];
const log = (label: string, value?: unknown) =>
  console.log(label, value === undefined ? '' : JSON.stringify(value));

async function main() {
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--', ...codePaths], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const codeSha = dirty
    ? ''
    : execFileSync('git', ['log', '-1', '--format=%H', '--', ...codePaths], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
  console.log(
    dirty ? `WORKING_TREE base=${sha}; preliminary only, NOT final-SHA evidence` : codeSha,
  );
  const previous = new Map(
    ['NODE_ENV', 'DATABASE_URL', 'DATABASE_SSL', 'DATABASE_SSL_CA_PATH'].map(key => [
      key,
      process.env[key],
    ]),
  );
  const databases = new Set<TempDatabase>();
  const roles: string[] = [];
  let server: DataSource | undefined;
  async function temporary(schema = true) {
    const db = await createTempDatabase();
    databases.add(db);
    log('TEMP DATABASE', db.name);
    if (schema) await migrate(db.url);
    return db;
  }
  async function transaction<T>(db: TempDatabase, work: () => Promise<T>): Promise<T> {
    await db.runner.startTransaction();
    try {
      const result = await work();
      await db.runner.commitTransaction();
      return result;
    } catch (error) {
      if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
      throw error;
    }
  }
  function cliEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', DATABASE_SSL: 'false' };
    delete env.DATABASE_SSL_CA_PATH;
    for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) delete env[key];
    return { ...env, ...overrides };
  }
  // Runs the same CLI as `npm run --silent check:invariants`, through ts-node, so the driver does
  // not depend on npm_execpath (it is started with node -r ts-node/register, where it is not set).
  function cli(db: TempDatabase, expectedExit: number, overrides: Record<string, string> = {}) {
    log('$ ts-node test/support/invariants.ts (same CLI as npm run --silent check:invariants)', {
      database: db.name,
    });
    const result = spawnSync(
      process.execPath,
      [
        '-r',
        require.resolve('ts-node/register'),
        '-r',
        require.resolve('tsconfig-paths/register'),
        cliFile,
      ],
      {
        cwd: backend,
        env: cliEnv({ DATABASE_URL: db.url, ...overrides }),
        encoding: 'utf8',
        timeout: 45_000,
      },
    );
    assert.ifError(result.error);
    if (result.stdout) console.log(result.stdout.trim());
    if (result.stderr) console.log(result.stderr.trim());
    log('EXIT', result.status);
    assert.equal(result.status, expectedExit);
    return JSON.parse(expectedExit === 2 ? result.stderr : result.stdout) as {
      status: string;
      databaseCode?: string;
      totals?: { debit: string; credit: string; balance: string };
      violations?: unknown[];
    };
  }
  async function reports(db: TempDatabase) {
    log('SQL> test/support/invariants.sql (one SELECT)');
    const [{ report }] = await db.runner.query(
      readFileSync(resolve(__dirname, '../support/invariants.sql'), 'utf8'),
    );
    log('RAW SQL REPORT', report);
    const fromFunction = await checkLedgerInvariants(db.runner);
    log('FUNCTION REPORT', fromFunction);
    const fromCli = cli(db, 0);
    assert.deepEqual(fromFunction, report);
    assert.deepEqual(fromCli, report);
    return fromFunction;
  }
  async function drop(db: TempDatabase) {
    if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
    await db.drop();
    databases.delete(db);
    log('DROPPED TEMP DATABASE', db.name);
  }
  async function cleanup() {
    for (const db of databases) await drop(db);
    if (server?.isInitialized) {
      for (const role of roles) {
        await server.query(`DROP ROLE "${role}"`);
        log('DROPPED FIXTURE ROLE', role);
      }
      roles.length = 0;
      await server.destroy();
    }
  }
  try {
    log('M-69-01 create owned PostgreSQL 17 container, disposable database and real migrations');
    const started = await startPostgresContainer();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = started.databaseUrl;
    process.env.DATABASE_SSL = 'false';
    delete process.env.DATABASE_SSL_CA_PATH;
    server = await new DataSource({ type: 'postgres', url: started.databaseUrl }).initialize();
    const db = await temporary();
    log(
      'SQL> SELECT name FROM migrations ORDER BY timestamp',
      await db.runner.query('SELECT name FROM migrations ORDER BY timestamp'),
    );
    assert.equal(cli(db, 0).status, 'PASS');
    log('$ npm run --silent check:invariants (fixed command string, shell)');
    const viaNpm = spawnSync('npm run --silent check:invariants', {
      cwd: backend,
      env: cliEnv({ DATABASE_URL: db.url }),
      encoding: 'utf8',
      shell: true,
      timeout: 60_000,
    });
    assert.ifError(viaNpm.error);
    assert.equal(viaNpm.status, 0);
    assert.equal((JSON.parse(viaNpm.stdout) as { status: string }).status, 'PASS');
    log('M-69-01 PASS (ts-node and npm script agree)');

    log(
      'M-69-02 seed SQL via invariant-fixtures.ts: deposit 1000000, transfer 250000, unused account, rejected order',
    );
    const refs = await transaction(db, () => seedInvariantLedger(db.runner));
    const before = await invariantState(db.runner);
    log('SQL> accounts/transfers/ledger_entries (IDs and money only)', before);
    assert.deepEqual((await reports(db)).totals, {
      debit: '1250000',
      credit: '1250000',
      balance: '0',
    });
    log('M-69-02 PASS');

    log('M-69-03 NOSUPERUSER table owner corrupts a committed balance by one dong');
    const role = `dbs_test_inv_${randomBytes(6).toString('hex')}`;
    assert(/^dbs_test_inv_[0-9a-f]{12}$/.test(role));
    await server.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    roles.push(role);
    await db.runner.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await db.runner.query(`ALTER TABLE public.accounts OWNER TO "${role}"`);
    async function ownerDelta(delta: string) {
      await transaction(db, async () => {
        await db.runner.query(`SET LOCAL ROLE "${role}"`);
        const [owner] = await db.runner.query(
          "SELECT current_user AS role,r.rolsuper,pg_get_userbyid(c.relowner)=current_user AS owns FROM pg_class c JOIN pg_roles r ON r.rolname=current_user WHERE c.oid='public.accounts'::regclass",
        );
        log('SQL> owner and superuser catalog proof', owner);
        assert.deepEqual(owner, { role, rolsuper: false, owns: true });
        log('SQL> UPDATE public.accounts SET balance=balance+$2::bigint WHERE id=$1', [
          refs.senderId,
          delta,
        ]);
        await db.runner.query('UPDATE public.accounts SET balance=balance+$2::bigint WHERE id=$1', [
          refs.senderId,
          delta,
        ]);
      });
    }
    await ownerDelta('1');
    const mismatch = cli(db, 1);
    assert.equal(mismatch.status, 'FAIL');
    assert.equal(mismatch.totals?.balance, '1');
    assert(JSON.stringify(mismatch.violations).includes(refs.senderId));
    const after = await invariantState(db.runner);
    assert.deepEqual(after.entries, before.entries);
    assert.deepEqual(after.transfers, before.transfers);
    log('M-69-03 PASS: violation detected; ledger/transfers unchanged');

    log('M-69-04 owner restores one dong and runs the real CLI again');
    await ownerDelta('-1');
    assert.equal(cli(db, 0).status, 'PASS');
    assert.deepEqual(await invariantState(db.runner), before);
    log('M-69-04 PASS');

    log('M-69-05 completed transfer with no ledger pair in another disposable database');
    const missing = await temporary();
    const missingId = await transaction(missing, async () => {
      const a = await seedInvariantAccounts(missing.runner);
      return postInvariantTransfer(missing.runner, {
        actorId: a.actorId,
        from: a.senderId,
        to: a.recipientId,
        amount: '100000',
        entries: [],
      });
    });
    const pair = cli(missing, 1);
    assert.equal(pair.status, 'FAIL');
    assert.deepEqual(pair.totals, { debit: '0', credit: '0', balance: '0' });
    assert(JSON.stringify(pair.violations).includes(missingId));
    assert.equal(pair.violations?.length, 1);
    await drop(missing);
    log('M-69-05 PASS');

    log('M-69-06 boundary amount 9007199254740993 is preserved by SQL/function/CLI');
    const large = await temporary();
    await transaction(large, async () => {
      const a = await seedInvariantAccounts(large.runner);
      await postInvariantTransfer(large.runner, {
        actorId: a.actorId,
        from: INVARIANT_FUNDING_ID,
        to: a.senderId,
        amount: '9007199254740993',
        type: 'DEPOSIT',
      });
    });
    assert.equal((await reports(large)).totals.debit, '9007199254740993');
    await drop(large);
    log('M-69-06 PASS');

    log('M-69-07 missing schema is an error; restored original fixture remains clean');
    const empty = await temporary(false);
    const error = cli(empty, 2);
    assert.equal(error.status, 'ERROR');
    assert.equal(error.databaseCode, '42P01');
    await drop(empty);
    assert.equal(cli(db, 0).status, 'PASS');
    log('M-69-07 PASS');

    log('M-69-09 the ECS DB_* parts (no DATABASE_URL), then a malformed DB_PORT');
    {
      const u = new URL(db.url);
      const parts = {
        DATABASE_URL: '',
        DB_HOST: u.hostname,
        DB_PORT: u.port,
        DB_NAME: decodeURIComponent(u.pathname.slice(1)),
        DB_USER: decodeURIComponent(u.username),
        DB_PASSWORD: decodeURIComponent(u.password),
      };
      const composed = cli(db, 0, parts);
      assert.equal(composed.status, 'PASS');
      log('DB_* composed into a connection: PASS, exit 0');
      const bad = cli(db, 2, { ...parts, DB_PORT: 'abc' }) as { kind?: string; invalid?: string[] };
      assert.equal(bad.kind, 'INVALID_CONFIG');
      assert.deepEqual(bad.invalid, ['DB_PORT']);
      assert(!JSON.stringify(bad).includes('abc'));
      log('M-69-09 PASS: INVALID_CONFIG names only DB_PORT, no value printed');
    }

    log('M-69-10 a mismatch stays FAIL (exit 1), never turned into ERROR, then restores');
    await ownerDelta('1');
    const stillFail = cli(db, 1);
    assert.equal(stillFail.status, 'FAIL');
    assert(JSON.stringify(stillFail.violations).includes(refs.senderId));
    await ownerDelta('-1');
    assert.equal(cli(db, 0).status, 'PASS');
    log('M-69-10 PASS');

    log(
      'M-69-08 cleanup owned databases/roles, stop ONLY this container, then verify a failed connection',
    );
    await cleanup();
    await stopPostgresContainer();
    assert.equal(cli(db, 2).status, 'ERROR');
    assert.equal(databases.size, 0);
    assert.equal(roles.length, 0);
    log('M-69-08 PASS');
    log('MANUAL RESULT', { passed: 10, total: 10, finalShaEvidence: !dirty });
  } finally {
    try {
      await cleanup();
    } finally {
      if (server?.isInitialized) await server.destroy();
      await stopPostgresContainer();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: 'MANUAL_ERROR', databaseCode: getErrorCode(error) }));
  process.exitCode = 1;
});
