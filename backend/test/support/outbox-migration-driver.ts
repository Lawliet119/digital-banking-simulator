import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createMigrationDataSource } from '@database/data-source';
import {
  createTempDatabase,
  migrate,
  migrateThrough,
  attempt,
  type TempDatabase,
} from './temp-database';
import { ACCOUNT_LOCKED_SAMPLE } from './event-samples';

const mode = process.argv[2];
const backend = resolve(__dirname, '../..');
const root = resolve(backend, '..');
const npm =
  process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const TARGET = 'CreateOutboxEventsProcessedEvents1792627200000';
const BASE = 'CreateTransfersLedgerIdempotency1791849600000';
const INSERT =
  'INSERT INTO outbox_events(event_id,event_type,aggregate_id,payload,correlation_id) VALUES($1,$2,$3,$4,$5) RETURNING *';
const values = () => [
  ACCOUNT_LOCKED_SAMPLE.eventId,
  ACCOUNT_LOCKED_SAMPLE.eventType,
  ACCOUNT_LOCKED_SAMPLE.accountId,
  ACCOUNT_LOCKED_SAMPLE,
  ACCOUNT_LOCKED_SAMPLE.correlationId,
];
const log = (text: string, data?: unknown) =>
  console.log(text, data === undefined ? '' : JSON.stringify(data));
function cli(script: string, db: TempDatabase, fail = false) {
  assert(existsSync(npm), 'npm CLI must exist');
  log(`$ npm run ${script} [DATABASE_URL supplied privately for ${db.name}]`);
  try {
    const output = execFileSync(process.execPath, [npm, 'run', script], {
      cwd: backend,
      env: { ...process.env, DATABASE_URL: db.url },
      encoding: 'utf8',
    });
    console.log(output);
    assert(!fail, 'CLI unexpectedly succeeded');
  } catch (error) {
    if (!fail) throw error;
    const child = error as { status?: number; stdout?: string; stderr?: string };
    assert(child.status !== undefined && child.status !== 0, 'Expected a failed CLI process');
    console.log(child.stdout ?? '');
    console.log(child.stderr ?? '');
    log('Expected CLI exit', child.status);
  }
}
async function run(db: TempDatabase, sql: string, params: unknown[] = []) {
  log(`SQL> ${sql}`, params);
  const rows: unknown = await db.runner.query(sql, params);
  log('RESULT', rows);
  return rows;
}
async function state(db: TempDatabase) {
  const result = {
    migrations: await db.runner.query('SELECT name,timestamp FROM migrations ORDER BY timestamp'),
    columns: await db.runner.query(
      "SELECT table_name,column_name,data_type,is_nullable,column_default,is_identity,identity_generation FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('outbox_events','processed_events') ORDER BY table_name,ordinal_position",
    ),
    indexes: await db.runner.query(
      "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('outbox_events','processed_events') ORDER BY indexname",
    ),
    funding: await db.runner.query('SELECT id,type,balance FROM accounts ORDER BY id'),
  };
  log('CATALOG', result);
  return result;
}
async function expected(work: () => Promise<unknown>, code: string, constraint?: string) {
  try {
    await work();
  } catch (error) {
    const pg = (error as { driverError?: { code: string; constraint?: string; column?: string } })
      .driverError;
    assert.equal(pg?.code, code);
    if (constraint) assert.equal(pg?.constraint, constraint);
    log(
      'EXPECTED POSTGRES ERROR',
      pg && { code: pg.code, constraint: pg.constraint, column: pg.column },
    );
    return;
  }
  throw new Error(`Expected SQLSTATE ${code}, operation succeeded`);
}
async function temporary(work: (db: TempDatabase) => Promise<void>, setup = true) {
  const db = await createTempDatabase();
  log('TEMP DATABASE', db.name);
  try {
    if (setup) cli('migration:run', db);
    await work(db);
  } finally {
    if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
    await db.drop();
    log('CLEANUP database dropped', db.name);
  }
}
async function wait(db: TempDatabase, pid: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const [r] = await db.runner.query(
      'SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1',
      [pid],
    );
    if (r?.wait_event_type === 'Lock') {
      log('OBSERVED LOCK WAIT', r);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Expected lock wait not observed');
}
async function main() {
  log('OUTBOX MANUAL MODE', mode);
  if (mode === 'roundtrip')
    await temporary(async db => {
      const original = await state(db);
      cli('migration:show', db);
      cli('migration:revert', db);
      const reverted = await state(db);
      assert.equal(reverted.columns.length, 0);
      assert.equal(reverted.migrations.length, 2);
      assert.deepEqual(reverted.funding, original.funding);
      cli('migration:run', db);
      assert.deepEqual(await state(db), original);
    });
  else if (mode === 'schema')
    await temporary(async db => {
      await run(db, 'SHOW server_version');
      await run(db, 'SHOW timezone');
      const catalog = await state(db);
      assert.equal(catalog.columns.length, 11);
      assert.equal(catalog.indexes.length, 5);
      for (const table of ['outbox_events', 'processed_events']) {
        log(`$ docker compose exec -T postgres psql -d ${db.name} -c \\d ${table}`);
        console.log(
          execFileSync(
            'docker',
            [
              'compose',
              '-f',
              resolve(root, 'docker-compose.yml'),
              'exec',
              '-T',
              'postgres',
              'psql',
              '-X',
              '-v',
              'ON_ERROR_STOP=1',
              '-U',
              decodeURIComponent(new URL(db.url).username),
              '-d',
              db.name,
              '-c',
              `\\d ${table}`,
            ],
            { cwd: root, encoding: 'utf8' },
          ),
        );
      }
    });
  else if (mode === 'rejection')
    await temporary(async db => {
      await run(db, INSERT, values());
      await db.runner.startTransaction();
      await expected(
        () => attempt(db.runner, INSERT, values()),
        '23505',
        'outbox_events_event_id_key',
      );
      const missing = values();
      missing[0] = '11111111-1111-4111-8111-111111111111';
      missing[4] = null as unknown as string;
      await expected(() => attempt(db.runner, INSERT, missing), '23502');
      await expected(
        () =>
          attempt(
            db.runner,
            'INSERT INTO outbox_events(id,event_type,aggregate_id,payload,correlation_id) VALUES(99,$1,$2,$3,$4)',
            values().slice(1),
          ),
        '428C9',
      );
      await run(
        db,
        "INSERT INTO processed_events(consumer,event_id) VALUES('risk',$1),('notification',$1) RETURNING *",
        [ACCOUNT_LOCKED_SAMPLE.eventId],
      );
      await expected(
        () =>
          attempt(db.runner, "INSERT INTO processed_events(consumer,event_id) VALUES('risk',$1)", [
            ACCOUNT_LOCKED_SAMPLE.eventId,
          ]),
        '23505',
        'processed_events_pkey',
      );
      const good = values();
      good[0] = '22222222-2222-4222-8222-222222222222';
      await run(db, INSERT, good);
      await db.runner.commitTransaction();
    });
  else if (mode === 'lifecycle')
    await temporary(async db => {
      await run(db, INSERT, values());
      assert.equal(
        (await db.runner.query('SELECT * FROM outbox_events WHERE published_at IS NULL')).length,
        1,
      );
      await run(db, 'UPDATE outbox_events SET published_at=clock_timestamp() RETURNING *');
      await run(db, 'SELECT id FROM outbox_events WHERE published_at IS NULL');
      await run(db, 'SELECT id FROM outbox_events WHERE published_at IS NOT NULL');
      await db.runner.startTransaction();
      const a = values();
      a[0] = '22222222-2222-4222-8222-222222222222';
      await run(db, INSERT, a);
      await run(db, "INSERT INTO processed_events(consumer,event_id) VALUES('risk',$1)", [a[0]]);
      await db.runner.rollbackTransaction();
      assert.equal((await db.runner.query('SELECT * FROM outbox_events')).length, 1);
      assert.equal((await db.runner.query('SELECT * FROM processed_events')).length, 0);
      await run(db, 'DELETE FROM outbox_events WHERE published_at IS NOT NULL RETURNING id');
      await run(db, "INSERT INTO processed_events(consumer,event_id) VALUES('risk',$1)", [a[0]]);
      await run(db, 'DELETE FROM processed_events RETURNING *');
    });
  else if (mode === 'revert-guard') {
    for (const kind of ['unpublished', 'published', 'processed'])
      await temporary(async db => {
        log('GUARD SCENARIO', kind);
        if (kind === 'processed')
          await run(db, "INSERT INTO processed_events(consumer,event_id) VALUES('risk',$1)", [
            ACCOUNT_LOCKED_SAMPLE.eventId,
          ]);
        else {
          await run(db, INSERT, values());
          if (kind === 'published')
            await run(db, 'UPDATE outbox_events SET published_at=clock_timestamp()');
        }
        const before = await state(db);
        const out = await db.runner.query('SELECT * FROM outbox_events');
        const processed = await db.runner.query('SELECT * FROM processed_events');
        cli('migration:revert', db, true);
        await expected(() => migrate(db.url, 'undoLast'), '55000');
        assert.deepEqual(await state(db), before);
        assert.deepEqual(await db.runner.query('SELECT * FROM outbox_events'), out);
        assert.deepEqual(await db.runner.query('SELECT * FROM processed_events'), processed);
        await run(db, 'DELETE FROM outbox_events WHERE event_id=$1 RETURNING id', [
          ACCOUNT_LOCKED_SAMPLE.eventId,
        ]);
        await run(db, 'DELETE FROM processed_events WHERE event_id=$1 RETURNING *', [
          ACCOUNT_LOCKED_SAMPLE.eventId,
        ]);
        cli('migration:revert', db);
        cli('migration:run', db);
        await state(db);
      });
  } else if (mode === 'atomic-up')
    await temporary(async db => {
      await migrateThrough(db.url, BASE);
      await run(db, 'CREATE TABLE processed_events(sentinel text)');
      cli('migration:run', db, true);
      await expected(() => migrate(db.url), '42P07');
      assert.deepEqual(
        await db.runner.query("SELECT to_regclass('public.outbox_events') AS name"),
        [{ name: null }],
      );
      await state(db);
      await run(db, 'DROP TABLE processed_events');
      cli('migration:run', db);
      assert.equal((await state(db)).columns.length, 11);
    }, false);
  else if (mode === 'revert-race') {
    for (const table of ['outbox_events', 'processed_events'])
      await temporary(async db => {
        const source = await createMigrationDataSource(db.url).initialize();
        const b = source.createQueryRunner();
        await b.connect();
        await b.startTransaction('READ COMMITTED');
        const [{ pid }] = await b.query('SELECT pg_backend_pid() AS pid');
        const migration = source.migrations.find(m => m.name === TARGET)!;
        let pending: Promise<unknown> | undefined;
        try {
          await db.runner.startTransaction();
          await run(db, `LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`);
          pending = migration.down(b).then(
            () => null,
            (error: unknown) => error,
          );
          await wait(db, pid);
          if (table === 'outbox_events') await run(db, INSERT, values());
          else
            await run(db, "INSERT INTO processed_events(consumer,event_id) VALUES('risk',$1)", [
              ACCOUNT_LOCKED_SAMPLE.eventId,
            ]);
          await db.runner.commitTransaction();
          const error = await pending;
          assert.equal((error as { driverError: { code: string } }).driverError.code, '55000');
          log('DOWN REFUSED after writer commit', { code: '55000', table });
          await b.rollbackTransaction();
          assert.equal((await db.runner.query(`SELECT * FROM ${table}`)).length, 1);
          await state(db);
        } finally {
          if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
          if (pending) await pending;
          if (b.isTransactionActive) await b.rollbackTransaction();
          await b.release();
          await source.destroy();
        }
      });
  } else if (mode === 'isolation-guard') {
    for (const table of ['outbox_events', 'processed_events'])
      await temporary(async db => {
        const source = await createMigrationDataSource(db.url).initialize();
        try {
          await db.runner.startTransaction('REPEATABLE READ');
          await run(db, 'SHOW transaction_isolation');
          await run(db, `SELECT * FROM ${table}`);
          if (table === 'outbox_events') await source.query(INSERT, values());
          else
            await source.query(
              "INSERT INTO processed_events(consumer,event_id) VALUES('risk',$1)",
              [ACCOUNT_LOCKED_SAMPLE.eventId],
            );
          await expected(
            () => source.migrations.find(m => m.name === TARGET)!.down(db.runner),
            '55000',
          );
          await db.runner.rollbackTransaction();
          await run(db, `SELECT * FROM ${table}`);
          await state(db);
          await run(db, `DELETE FROM ${table} WHERE event_id=$1`, [ACCOUNT_LOCKED_SAMPLE.eventId]);
          await run(db, 'SHOW transaction_isolation');
          cli('migration:revert', db);
          cli('migration:run', db);
        } finally {
          if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
          await source.destroy();
        }
      });
  } else throw new Error('Unknown manual mode');
  log('MANUAL MODE PASS', mode);
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[redacted database URL]'));
  process.exitCode = 1;
});
