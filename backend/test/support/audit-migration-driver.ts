import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMigrationDataSource } from '@database/data-source';
import {
  createTempDatabase,
  migrate,
  migrateThrough,
  attempt,
  type TempDatabase,
} from './temp-database';

const mode = process.argv[2];
const npm =
  process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const backend = resolve(__dirname, '../..');
const TARGET = 'CreateAuditLog1792627200001';
const BASE = 'CreateTransfersLedgerIdempotency1791849600000';
const INSERT =
  'INSERT INTO audit_log(actor_user_id,actor_role,action,outcome,target_type,target_id,correlation_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *';
const values = (): unknown[] => [
  null,
  'system',
  'audit.search',
  'SUCCESS',
  'correlation',
  'account-absent',
  randomUUID(),
  { reason: 'ACCOUNT_NOT_ACTIVE' },
];
const log = (text: string, data?: unknown) =>
  console.log(text, data === undefined ? '' : JSON.stringify(data));
function cli(db: TempDatabase, script: string, fail = false) {
  assert(existsSync(npm));
  log(`$ npm run ${script} [private database URL: ${db.name}]`);
  try {
    console.log(
      execFileSync(process.execPath, [npm, 'run', script], {
        cwd: backend,
        env: { ...process.env, DATABASE_URL: db.url },
        encoding: 'utf8',
      }),
    );
    assert(!fail, 'Expected CLI to fail');
  } catch (error) {
    if (!fail) throw error;
    const child = error as { status?: number; stdout?: string; stderr?: string };
    assert(child.status !== undefined && child.status !== 0);
    console.log(child.stdout ?? '');
    console.log(child.stderr ?? '');
    log('EXPECTED CLI EXIT', child.status);
  }
}
async function run(db: TempDatabase, sql: string, params: unknown[] = []) {
  log(`SQL> ${sql}`, params);
  const result: unknown = await db.runner.query(sql, params);
  log('RESULT', result);
  return result;
}
async function state(db: TempDatabase) {
  const columns = await db.runner.query(
    "SELECT column_name,data_type,is_nullable,column_default,is_identity,identity_generation FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_log' ORDER BY ordinal_position",
  );
  const indexes = await db.runner.query(
    "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='audit_log' ORDER BY indexname",
  );
  const constraints = await db.runner.query(
    "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass('public.audit_log') ORDER BY conname",
  );
  const history = await db.runner.query('SELECT name,timestamp FROM migrations ORDER BY timestamp');
  log('SCHEMA audit_log');
  for (const row of columns) log('COLUMN', row);
  for (const row of indexes) log('INDEX', row);
  for (const row of constraints) log('CONSTRAINT', row);
  log('HISTORY', history);
  return {
    columns,
    indexes,
    constraints,
    history,
    funding: await db.runner.query('SELECT id,type,balance FROM accounts ORDER BY id'),
  };
}
async function expected(work: () => Promise<unknown>, code: string, constraint?: string) {
  try {
    await work();
  } catch (error) {
    const pg =
      (
        error as {
          driverError?: { code: string; constraint?: string; column?: string };
          code?: string;
        }
      ).driverError ?? (error as { code: string; constraint?: string; column?: string });
    assert.equal(pg.code, code);
    if (constraint) assert.equal(pg.constraint, constraint);
    log('EXPECTED POSTGRES ERROR', { code: pg.code, constraint: pg.constraint, column: pg.column });
    return;
  }
  throw new Error(`Expected ${code}, operation succeeded`);
}
async function temporary(work: (db: TempDatabase) => Promise<void>, setup = true) {
  const db = await createTempDatabase();
  log('TEMP DATABASE', db.name);
  try {
    if (setup) cli(db, 'migration:run');
    await run(db, 'SHOW server_version');
    await run(db, 'SHOW timezone');
    await run(db, 'SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user');
    await work(db);
  } finally {
    if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
    await db.drop();
    log('CLEANUP database dropped', db.name);
  }
}
async function main() {
  log('AUDIT MANUAL MODE', mode);
  if (mode === 'lifecycle')
    await temporary(async db => {
      const before = await state(db);
      cli(db, 'migration:revert');
      const undone = await state(db);
      assert.equal(undone.columns.length, 0);
      assert.equal(undone.history.length, 2);
      assert.deepEqual(undone.funding, before.funding);
      cli(db, 'migration:run');
      assert.deepEqual(await state(db), before);
    });
  else if (mode === 'rows')
    await temporary(async db => {
      await run(
        db,
        "SELECT setval(pg_get_serial_sequence('audit_log','id'),9007199254740992,true)",
      );
      const [system] = await db.runner.query(
        "INSERT INTO audit_log(actor_role,action,outcome,target_type,target_id,correlation_id) VALUES('system','audit.search','SUCCESS','correlation','account-absent',gen_random_uuid()) RETURNING *",
      );
      log('RESULT system defaults', system);
      assert.equal(system.id, '9007199254740993');
      assert.equal(system.actor_user_id, null);
      assert.deepEqual(system.metadata, {});
      const [user] = await db.runner.query(
        "INSERT INTO users(cognito_sub) VALUES('minh-local') RETURNING id",
      );
      for (const outcome of ['REJECTED', 'DENIED']) {
        const a = values();
        a[0] = user.id;
        a[1] = 'operator';
        a[3] = outcome;
        await run(db, INSERT, a);
      }
      await run(db, 'SELECT * FROM audit_log WHERE actor_user_id=$1 ORDER BY occurred_at DESC', [
        user.id,
      ]);
      await run(
        db,
        "SELECT * FROM audit_log WHERE action='audit.search' ORDER BY occurred_at DESC",
      );
      await run(db, 'SELECT * FROM audit_log WHERE correlation_id=$1', [system.correlation_id]);
    });
  else if (mode === 'rejections')
    await temporary(async db => {
      const [seed] = await db.runner.query(INSERT, values());
      await db.runner.startTransaction();
      for (const [index, bad, code, constraint] of [
        [3, 'FAILED', '23514', 'audit_log_outcome_check'],
        [0, randomUUID(), '23503', 'audit_log_actor_user_id_fkey'],
        [6, null, '23502', undefined],
        [6, 'bad', '22P02', undefined],
        [7, '{broken', '22P02', undefined],
      ] as const) {
        const a = values();
        a[index] = bad;
        log('SQL rejection input', { index, bad });
        await expected(() => attempt(db.runner, INSERT, a), code, constraint);
      }
      await expected(
        () =>
          attempt(
            db.runner,
            'INSERT INTO audit_log(id,actor_user_id,actor_role,action,outcome,target_type,target_id,correlation_id,metadata) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [seed.id, ...values()],
          ),
        '23505',
        'audit_log_pkey',
      );
      await run(db, INSERT, values());
      await db.runner.commitTransaction();
    });
  else if (mode === 'revert-guard')
    await temporary(async db => {
      await run(db, INSERT, values());
      const before = await state(db);
      const rows = await db.runner.query('SELECT * FROM audit_log ORDER BY id');
      cli(db, 'migration:revert', true);
      await expected(() => migrate(db.url, 'undoLast'), '55000');
      assert.deepEqual(await state(db), before);
      assert.deepEqual(await db.runner.query('SELECT * FROM audit_log ORDER BY id'), rows);
      log('PRESERVED committed audit rows', rows);
      cli(db, 'migration:run');
    });
  else if (mode === 'locking') {
    for (const order of ['writer-first', 'down-first'])
      await temporary(async db => {
        const source = await createMigrationDataSource(db.url).initialize();
        const migration = source.migrations.find(m => m.name === TARGET)!;
        const b = source.createQueryRunner();
        await b.connect();
        await b.startTransaction('READ COMMITTED');
        const [{ pid }] = await b.query('SELECT pg_backend_pid() AS pid');
        await db.runner.startTransaction('READ COMMITTED');
        let pending: Promise<unknown> | undefined;
        const wait = async () => {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const [r] = await source.query(
              'SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1',
              [pid],
            );
            if (r?.wait_event_type === 'Lock') {
              log('OBSERVED LOCK WAIT', { order, ...r });
              return;
            }
          }
          throw new Error('No lock wait observed');
        };
        try {
          if (order === 'writer-first') {
            await run(db, INSERT, values());
            pending = migration.down(b).then(
              () => null,
              (e: unknown) => e,
            );
            await wait();
            await db.runner.commitTransaction();
            const error = await pending;
            assert.equal((error as { driverError: { code: string } }).driverError.code, '55000');
            log('EXPECTED POSTGRES ERROR', { code: '55000', order });
            await b.rollbackTransaction();
            assert.equal((await db.runner.query('SELECT * FROM audit_log')).length, 1);
            await state(db);
          } else {
            await migration.down(db.runner);
            pending = b.query(INSERT, values()).then(
              () => null,
              (e: unknown) => e,
            );
            await wait();
            await source.query('SELECT pg_cancel_backend($1)', [pid]);
            const error = await pending;
            assert.equal((error as { driverError: { code: string } }).driverError.code, '57014');
            log('EXPECTED POSTGRES ERROR', { code: '57014', order });
            await b.rollbackTransaction();
            await db.runner.commitTransaction();
            await expected(() => b.query(INSERT, values()), '42P01');
          }
        } finally {
          if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
          if (pending) await pending;
          if (b.isTransactionActive) await b.rollbackTransaction();
          await b.release();
          await source.destroy();
        }
      });
  } else if (mode === 'recovery')
    await temporary(async db => {
      await migrateThrough(db.url, BASE);
      await run(db, 'CREATE TABLE audit_sentinel(id int)');
      await run(db, 'CREATE INDEX audit_log_actor_occurred_idx ON audit_sentinel(id)');
      cli(db, 'migration:run', true);
      await expected(() => migrate(db.url), '42P07');
      assert.equal((await state(db)).columns.length, 0);
      await run(db, 'DROP TABLE audit_sentinel');
      cli(db, 'migration:run');
      assert.equal((await state(db)).columns.length, 10);
    }, false);
  else if (mode === 'preconditions') {
    for (const isolation of [
      'NONE',
      'READ UNCOMMITTED',
      'SERIALIZABLE',
      'REPEATABLE READ',
    ] as const)
      await temporary(async db => {
        const source = await createMigrationDataSource(db.url).initialize();
        try {
          if (isolation !== 'NONE') await db.runner.startTransaction(isolation);
          log('LOCK GUARD preconditions', { isolation, active: db.runner.isTransactionActive });
          if (isolation === 'REPEATABLE READ') {
            await run(db, 'SELECT * FROM audit_log');
            await source.query(INSERT, values());
          }
          await expected(
            () => source.migrations.find(m => m.name === TARGET)!.down(db.runner),
            '55000',
          );
          if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
          if (isolation === 'REPEATABLE READ')
            assert.equal((await db.runner.query('SELECT * FROM audit_log')).length, 1);
          await state(db);
        } finally {
          if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
          await source.destroy();
        }
      });
  } else if (mode === 'legacy-lifecycle')
    await temporary(async db => {
      const names = async (): Promise<{ name: string }[]> => {
        const result: unknown = await db.runner.query(
          'SELECT name FROM migrations ORDER BY timestamp',
        );
        return result as { name: string }[];
      };
      const latest = await names();
      while ((await names()).length > 2) {
        cli(db, 'migration:revert');
        log('HISTORY', await names());
      }
      cli(db, 'migration:revert');
      assert.equal((await names()).length, 1);
      log('HISTORY', await names());
      cli(db, 'migration:revert');
      assert.equal((await names()).length, 0);
      log('HISTORY', await names());
      cli(db, 'migration:run');
      assert.deepEqual(await names(), latest);
      await state(db);
    });
  else throw new Error('Unknown manual mode');
  log('MANUAL MODE PASS', mode);
}
main().catch((e: unknown) => {
  console.error(
    (e instanceof Error ? e.message : String(e)).replace(
      /postgres(?:ql)?:\/\/[^\s]+/g,
      '[redacted database URL]',
    ),
  );
  process.exitCode = 1;
});
