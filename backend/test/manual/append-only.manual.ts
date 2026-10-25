import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DataSource } from 'typeorm';
import {
  attempt,
  createTempDatabase,
  requireDatabaseUrl,
  type TempDatabase,
} from '../support/temp-database';

const TABLES = ['ledger_entries', 'transfers', 'audit_log'] as const;
const TARGET = 'AddAppendOnlyTriggers1792627200002';
const npm =
  process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const role = `dbs_test_owner_${randomBytes(6).toString('hex')}`;
const log = (label: string, value?: unknown) =>
  console.log(label, value === undefined ? '' : JSON.stringify(value));

export function unmatchedMutationSql(
  table: (typeof TABLES)[number],
  verb: 'UPDATE' | 'DELETE',
): string {
  const column =
    table === 'ledger_entries'
      ? 'balance_after'
      : table === 'transfers'
        ? 'correlation_id'
        : 'target_id';
  return verb === 'UPDATE'
    ? `UPDATE ${table} SET ${column}=${column} WHERE false RETURNING id`
    : `DELETE FROM ${table} WHERE false RETURNING id`;
}

function cli(script: string, db: TempDatabase, args: string[] = []) {
  assert(existsSync(npm));
  log(`$ npm run ${script} ${args.join(' ')} [temporary database: ${db.name}]`);
  console.log(
    execFileSync(process.execPath, [npm, 'run', script, ...args], {
      cwd: resolve(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: db.url },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}
async function sql(
  db: TempDatabase,
  text: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  log(`SQL> ${text}`, params);
  const rows: Record<string, unknown>[] = await db.runner.query(text, params);
  log('RESULT', rows);
  return rows;
}
async function snapshot(db: TempDatabase) {
  const state = {
    ledger: await sql(db, 'SELECT * FROM public.ledger_entries ORDER BY id'),
    transfers: await sql(db, 'SELECT * FROM public.transfers ORDER BY id'),
    audit: await sql(db, 'SELECT * FROM public.audit_log ORDER BY id'),
    keys: await sql(db, 'SELECT * FROM public.idempotency_keys ORDER BY user_id,idem_key'),
    balances: await sql(db, 'SELECT id,balance FROM public.accounts ORDER BY id'),
  };
  return state;
}
const sequences = (db: TempDatabase) =>
  sql(
    db,
    "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' AND sequencename IN ('ledger_entries_id_seq','audit_log_id_seq') ORDER BY sequencename",
  );

async function ownership(db: TempDatabase) {
  await sql(db, `SET LOCAL ROLE "${role}"`);
  const owners = await sql(
    db,
    "SELECT current_user AS effective_role,c.relname,pg_get_userbyid(c.relowner)=current_user AS owns,r.rolsuper FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.rolname=current_user WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname",
    [TABLES],
  );
  assert.deepEqual(
    owners,
    [...TABLES]
      .sort()
      .map(relname => ({ effective_role: role, relname, owns: true, rolsuper: false })),
  );
  const required = TABLES.flatMap(table =>
    ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map(privilege => [table, privilege]),
  );
  required.push(
    ['accounts', 'SELECT'],
    ['idempotency_keys', 'SELECT'],
    ['idempotency_keys', 'TRUNCATE'],
  );
  const allowed = await sql(
    db,
    'SELECT table_name,privilege,has_table_privilege(current_user,table_name,privilege) AS allowed FROM unnest($1::text[],$2::text[]) AS required(table_name,privilege)',
    [required.map(row => row[0]), required.map(row => row[1])],
  );
  assert.equal(allowed.length, required.length);
  assert(allowed.every(row => row.allowed === true));
  const denied = await sql(
    db,
    "SELECT table_name,privilege,has_table_privilege(current_user,table_name,privilege) AS allowed FROM (VALUES ('accounts','UPDATE'),('accounts','DELETE'),('idempotency_keys','UPDATE'),('idempotency_keys','DELETE'),('idempotency_keys','INSERT')) AS outside_target(table_name,privilege)",
  );
  assert(denied.every(row => row.allowed === false));
  log('OWNER AND PRIVILEGES PASS', { role, superuser: false, targets: TABLES });
}
async function assignOwner(db: TempDatabase) {
  assert(/^dbs_test_owner_[0-9a-f]{12}$/.test(role));
  for (const table of TABLES) await sql(db, `ALTER TABLE public.${table} OWNER TO "${role}"`);
  await sql(db, `GRANT SELECT ON public.accounts,public.idempotency_keys TO "${role}"`);
  await sql(db, `GRANT TRUNCATE ON public.idempotency_keys TO "${role}"`);
}
async function catalog(db: TempDatabase) {
  const history = await sql(db, 'SELECT name FROM migrations ORDER BY timestamp,id');
  assert.equal(history.at(-1)?.name, TARGET);
  const functions = await sql(
    db,
    "SELECT p.proname,p.prosecdef,l.lanname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname='forbid_mutation'",
  );
  assert.equal(functions.length, 1);
  assert.equal(functions[0].prosecdef, false);
  assert.equal(functions[0].lanname, 'plpgsql');
  const triggers = await sql(
    db,
    "SELECT t.tgname,t.tgtype,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t WHERE t.tgfoid='public.forbid_mutation()'::regprocedure ORDER BY t.tgname",
  );
  assert.deepEqual(
    triggers.map(({ tgname, tgtype, tgenabled }) => ({ tgname, tgtype, tgenabled })),
    [...TABLES].sort().flatMap(table => [
      { tgname: `${table}_append_only`, tgtype: 27, tgenabled: 'O' },
      { tgname: `${table}_no_truncate`, tgtype: 34, tgenabled: 'O' },
    ]),
  );
  await sql(
    db,
    "SELECT table_name,column_name,data_type,is_nullable,column_default,is_identity FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position",
    [TABLES],
  );
  await sql(
    db,
    'SELECT conrelid::regclass::text AS table_name,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=ANY($1::regclass[]) ORDER BY conrelid::regclass::text,conname',
    [TABLES],
  );
  await sql(
    db,
    "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY tablename,indexname",
    [TABLES],
  );
  log('CATALOG PASS', { functions: 1, enabledTriggers: 6, migration: TARGET });
}
async function blocked(db: TempDatabase, text: string, params: unknown[] = []) {
  await db.runner.startTransaction();
  try {
    await ownership(db);
    const before = await snapshot(db);
    log(`SQL> ${text}`, params);
    let rejected = false;
    try {
      await attempt(db.runner, text, params);
    } catch (error) {
      const pg = (error as { driverError: { code: string; where?: string } }).driverError;
      log('EXPECTED TRIGGER ERROR', { code: pg.code, where: pg.where, sql: text });
      assert.equal(pg.code, '42501');
      assert.match(
        pg.where ?? '',
        /PL\/pgSQL function (?:public\.)?forbid_mutation\(\) line \d+ at RAISE/,
      );
      rejected = true;
    }
    assert(rejected, `Mutation unexpectedly succeeded: ${text}`);
    assert.deepEqual(await snapshot(db), before);
    log('SNAPSHOT UNCHANGED', text);
  } finally {
    await db.runner.rollbackTransaction();
  }
}
async function mutationMatrix(db: TempDatabase, sameValue: boolean) {
  for (const table of TABLES) {
    const column =
      table === 'ledger_entries'
        ? 'balance_after'
        : table === 'transfers'
          ? 'correlation_id'
          : 'target_id';
    const replacement =
      table === 'ledger_entries' ? 'balance_after+1' : table === 'transfers' ? '$1' : "'changed'";
    await blocked(
      db,
      `UPDATE ${table} SET ${column}=${replacement}`,
      table === 'transfers' ? [randomUUID()] : [],
    );
    await blocked(db, `DELETE FROM ${table}`);
    await blocked(db, `TRUNCATE ${table}${table === 'transfers' ? ' CASCADE' : ''}`);
    if (sameValue) await blocked(db, `UPDATE ${table} SET ${column}=${column}`);
  }
}
async function seed(db: TempDatabase) {
  const accounts: string[] = [];
  let user = '';
  await db.runner.startTransaction();
  try {
    for (const [subject, name] of [
      ['minh-local', 'Nguyễn Minh'],
      ['lan-local', 'Trần Lan'],
    ]) {
      const users = await sql(db, 'INSERT INTO users(cognito_sub) VALUES($1) RETURNING id', [
        subject,
      ]);
      user = String(users[0].id);
      const customers = await sql(
        db,
        'INSERT INTO customers(user_id,full_name) VALUES($1,$2) RETURNING id',
        [user, name],
      );
      const rows = await sql(
        db,
        "INSERT INTO accounts(customer_id,type) VALUES($1,'CHECKING') RETURNING id,balance",
        [customers[0].id],
      );
      assert.equal(rows[0].balance, '0');
      accounts.push(String(rows[0].id));
    }
    await assignOwner(db);
    await ownership(db);
    const transfers = await sql(
      db,
      "INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id) VALUES('TRANSFER',$1,$2,'250000','COMPLETED',$3,$4) RETURNING *",
      [accounts[0], accounts[1], user, randomUUID()],
    );
    const ledger = await sql(
      db,
      "INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after) VALUES($1,$2,'DEBIT','250000','0'),($1,$3,'CREDIT','250000','0') RETURNING *",
      [transfers[0].id, accounts[0], accounts[1]],
    );
    const audit = await sql(
      db,
      "INSERT INTO audit_log(actor_user_id,actor_role,action,outcome,target_type,target_id,correlation_id) VALUES($1,'operator','transfer.create','SUCCESS','transfer',$2,$3) RETURNING *",
      [user, transfers[0].id, randomUUID()],
    );
    assert.equal(ledger.length, 2);
    assert.equal(audit.length, 1);
    await sql(db, 'RESET ROLE');
    await sql(
      db,
      "INSERT INTO idempotency_keys(user_id,idem_key,request_hash,transfer_id) VALUES($1,'chuyen-tien-minh-lan',repeat('a',64),$2) RETURNING *",
      [user, transfers[0].id],
    );
    await ownership(db);
    const state = await snapshot(db);
    assert.equal(state.transfers.length, 1);
    assert.equal(state.ledger.length, 2);
    assert.equal(state.audit.length, 1);
    assert.equal(state.keys.length, 1);
    assert.equal(state.keys[0].transfer_id, transfers[0].id);
    assert(state.balances.every(row => row.balance === '0'));
    await db.runner.commitTransaction();
    log('OWNER INSERT PASS', { transfers: 1, ledger: 2, audit: 1, keys: 1, accountBalances: '0' });
    return state;
  } catch (error) {
    await db.runner.rollbackTransaction();
    throw error;
  }
}
async function main() {
  const server = await new DataSource({ type: 'postgres', url: requireDatabaseUrl() }).initialize();
  const active = new Set<TempDatabase>();
  const names: string[] = [];
  let roleCreated = false;
  async function create() {
    const db = await createTempDatabase();
    active.add(db);
    names.push(db.name);
    log('CREATED TEMP DATABASE', db.name);
    return db;
  }
  try {
    log('MANUAL STEP M-27-01 migrations and catalog');
    assert(/^dbs_test_owner_[0-9a-f]{12}$/.test(role));
    log(`SQL> CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await server.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    roleCreated = true;
    const db = await create();
    cli('migration:run', db);
    await sql(
      db,
      "SELECT current_setting('server_version') AS version,current_setting('timezone') AS timezone",
    );
    await catalog(db);
    log('MANUAL STEP PASS M-27-01');

    log('MANUAL STEP M-27-02 owner INSERT and seed SQL');
    const baseline = await seed(db);
    log('MANUAL STEP PASS M-27-02');

    log('MANUAL STEP M-27-03 populated mutation and same-value matrix');
    await mutationMatrix(db, true);
    assert.deepEqual(await snapshot(db), baseline);
    log('MANUAL STEP PASS M-27-03');

    log('MANUAL STEP M-27-04 empty TRUNCATE and no-match rows');
    const empty = await create();
    cli('migration:run', empty);
    await assignOwner(empty);
    for (const table of TABLES) {
      assert.deepEqual(await sql(empty, `SELECT * FROM ${table}`), []);
      await blocked(empty, `TRUNCATE ${table}${table === 'transfers' ? ' CASCADE' : ''}`);
    }
    await empty.drop();
    active.delete(empty);
    log('DROPPED TEMP DATABASE', empty.name);
    await db.runner.startTransaction();
    try {
      for (const table of TABLES)
        for (const verb of ['UPDATE', 'DELETE'] as const) {
          await ownership(db);
          const text = unmatchedMutationSql(table, verb);
          log(`SQL> ${text}`);
          const result = await db.runner.query(text, undefined, true);
          log('NO-MATCH RESULT', result);
          assert.equal(result.affected, 0);
          assert.deepEqual(result.records, []);
          assert.deepEqual(await snapshot(db), baseline);
        }
    } finally {
      await db.runner.rollbackTransaction();
    }
    log('MANUAL STEP PASS M-27-04');

    log('MANUAL STEP M-27-05 revert keeps data and ACL negative controls');
    const beforeSequences = await sequences(db);
    assert.equal(
      (await sql(db, 'SELECT name FROM migrations ORDER BY timestamp,id')).at(-1)?.name,
      TARGET,
    );
    cli('migration:revert', db);
    assert.deepEqual(await snapshot(db), baseline);
    assert.deepEqual(await sequences(db), beforeSequences);
    assert.deepEqual(await sql(db, "SELECT to_regprocedure('public.forbid_mutation()') AS name"), [
      { name: null },
    ]);
    assert.deepEqual(
      await sql(
        db,
        'SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid=ANY($1::regclass[])',
        [TABLES],
      ),
      [],
    );
    await db.runner.startTransaction();
    try {
      await ownership(db);
      await sql(db, 'SAVEPOINT negative_control');
      const update = "UPDATE audit_log SET target_id='rollback-check' RETURNING id";
      log(`SQL> ${update}`);
      const result = await db.runner.query(update, undefined, true);
      assert.equal(result.affected, 1);
      log('NEGATIVE CONTROL UPDATE SUCCEEDED', result);
      await sql(db, 'ROLLBACK TO SAVEPOINT negative_control');
      await ownership(db);
      await sql(db, 'TRUNCATE transfers CASCADE');
      const truncated = await snapshot(db);
      assert.equal(truncated.transfers.length, 0);
      assert.equal(truncated.ledger.length, 0);
      assert.equal(truncated.keys.length, 0);
      log('NEGATIVE CONTROL CASCADE SUCCEEDED', { transfers: 0, ledger: 0, keys: 0 });
      await sql(db, 'ROLLBACK TO SAVEPOINT negative_control');
      assert.deepEqual(await snapshot(db), baseline);
    } finally {
      await db.runner.rollbackTransaction();
    }
    log('MANUAL STEP PASS M-27-05');

    log('MANUAL STEP M-27-06 re-run restores protection');
    cli('migration:run', db);
    await catalog(db);
    assert.deepEqual(await snapshot(db), baseline);
    assert.deepEqual(await sequences(db), beforeSequences);
    await mutationMatrix(db, false);
    await db.runner.startTransaction();
    try {
      await ownership(db);
      const inserted = await sql(
        db,
        "INSERT INTO audit_log(actor_role,action,outcome,target_type,target_id,correlation_id) VALUES('system','audit.search','SUCCESS','correlation','operator-check',$1) RETURNING *",
        [randomUUID()],
      );
      assert.equal(inserted.length, 1);
      log('INSERT AFTER RE-RUN PASS', inserted);
    } finally {
      await db.runner.rollbackTransaction();
    }
    assert.deepEqual(await snapshot(db), baseline);
    log('MANUAL STEP PASS M-27-06');

    log('MANUAL STEP M-27-07 automated regression and baseline');
    for (const script of ['test:db', 'lint:check', 'typecheck', 'test', 'test:e2e', 'build'])
      cli(script, db, script.startsWith('test') ? ['--', '--runInBand'] : []);
    log('MANUAL STEP PASS M-27-07');
  } finally {
    log('MANUAL STEP M-27-08 cleanup');
    try {
      for (const db of active) {
        if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
        await db.runner.query('RESET ROLE');
        await db.drop();
        log('DROPPED TEMP DATABASE', db.name);
      }
      if (roleCreated) {
        await server.query(`DROP ROLE "${role}"`);
        log('DROPPED TEMP ROLE', role);
      }
      const databases = await server.query(
        'SELECT datname FROM pg_database WHERE datname=ANY($1::text[])',
        [names],
      );
      const roles = await server.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [role]);
      log('CLEANUP RESULT', { databases, roles });
      assert.deepEqual(databases, []);
      assert.deepEqual(roles, []);
      log('MANUAL STEP PASS M-27-08');
    } finally {
      await server.destroy();
    }
  }
  log('ALL APPEND-ONLY MANUAL STEPS PASS');
}
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'APPEND-ONLY MANUAL FAILED',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
}
