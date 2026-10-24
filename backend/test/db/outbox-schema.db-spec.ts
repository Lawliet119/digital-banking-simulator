import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DataSource, type MigrationInterface } from 'typeorm';
import { createMigrationDataSource } from '@database/data-source';
import {
  createTempDatabase,
  migrate,
  migrateThrough,
  attempt,
  type TempDatabase,
} from '../support/temp-database';

const FIRST = 'CreateUsersCustomersAccounts1791763200000';
const SECOND = 'CreateTransfersLedgerIdempotency1791849600000';

describe('outbox migration: prefix regression', () => {
  let db: TempDatabase;
  beforeEach(async () => {
    db = await createTempDatabase();
  });
  afterEach(async () => {
    await db?.drop();
  });

  it('TC-25-19 selects real prefixes, is idempotent, and refuses unknown/gapped/older history without DDL', async () => {
    const names = async () =>
      (
        (await db.runner.query('SELECT name FROM migrations ORDER BY timestamp')) as {
          name: string;
        }[]
      ).map(r => r.name);
    await expect(migrateThrough(db.url, 'MissingMigration')).rejects.toMatchObject({
      code: 'MIGRATION_TARGET_UNKNOWN',
    });
    expect(await db.runner.query("SELECT to_regclass('public.migrations') AS name")).toEqual([
      { name: null },
    ]);
    await migrateThrough(db.url, FIRST);
    expect(await names()).toEqual([FIRST]);
    await migrateThrough(db.url, SECOND);
    await migrateThrough(db.url, SECOND);
    expect(await names()).toEqual([FIRST, SECOND]);
    await expect(migrateThrough(db.url, FIRST)).rejects.toMatchObject({
      code: 'MIGRATION_HISTORY_INVALID',
    });
    expect(await names()).toEqual([FIRST, SECOND]);
    await db.runner.query('DELETE FROM migrations WHERE name=$1', [FIRST]);
    await expect(migrateThrough(db.url, SECOND)).rejects.toMatchObject({
      code: 'MIGRATION_HISTORY_INVALID',
    });
    expect(await names()).toEqual([SECOND]);
    expect(await db.runner.query("SELECT to_regclass('public.transfers') AS name")).toEqual([
      { name: 'transfers' },
    ]);
  });
});

const OUTBOX = 'CreateOutboxEventsProcessedEvents1792627200000';
const event = () => [
  randomUUID(),
  'AccountStatusChanged',
  randomUUID(),
  { status: 'LOCKED' },
  randomUUID(),
];
const INSERT =
  'INSERT INTO outbox_events(event_id,event_type,aggregate_id,payload,correlation_id) VALUES($1,$2,$3,$4,$5) RETURNING *';

function cli(script: string, url: string) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run these tests through `npm run test:db`.');
  execFileSync(process.execPath, [npmCli, 'run', script], {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

describe('outbox migration schema and safety', () => {
  let db: TempDatabase;
  let source: DataSource;
  let migration: MigrationInterface;
  beforeEach(async () => {
    db = await createTempDatabase();
    await migrateThrough(db.url, OUTBOX);
    source = await createMigrationDataSource(db.url).initialize();
    migration = source.migrations.find(m => m.name === OUTBOX)!;
  });
  afterEach(async () => {
    if (db?.runner.isTransactionActive) await db.runner.rollbackTransaction();
    if (source?.isInitialized) await source.destroy();
    await db?.drop();
  });
  const q = (sql: string, params: unknown[] = []) => db.runner.query(sql, params);
  const rows = () => q('SELECT * FROM outbox_events ORDER BY id');
  const history = () => q('SELECT name,timestamp FROM migrations ORDER BY timestamp');
  async function revertSuccessors() {
    const applied: { name: string; timestamp: string }[] = await history();
    const position = applied.findIndex(row => row.name === OUTBOX);
    expect(position).toBeGreaterThanOrEqual(0);
    for (let index = applied.length - 1; index > position; index--) {
      cli('migration:revert', db.url);
      expect(await history()).toEqual(applied.slice(0, index));
    }
  }
  async function catalog() {
    return {
      columns: await q(
        "SELECT table_name,column_name,data_type,is_nullable,column_default,is_identity,identity_generation FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('outbox_events','processed_events') ORDER BY table_name,ordinal_position",
      ),
      indexes: await q(
        "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('outbox_events','processed_events') ORDER BY indexname",
      ),
      history: await history(),
    };
  }
  async function rejects(
    sql: string,
    params: unknown[],
    code: string,
    extra: Record<string, unknown> = {},
  ) {
    await db.runner.startTransaction();
    try {
      await expect(attempt(db.runner, sql, params)).rejects.toMatchObject({
        driverError: { code, ...extra },
      });
    } finally {
      await db.runner.rollbackTransaction();
    }
  }
  async function waitLock(pid: number) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const [state] = await source.query(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',
        [pid],
      );
      if (state?.wait_event_type === 'Lock') return;
    }
    throw new Error('Backend never waited for the expected lock');
  }

  it('TC-25-01 exact columns, types, nullability, defaults and named constraints', async () => {
    const c = await catalog();
    const out = c.columns.filter((r: { table_name: string }) => r.table_name === 'outbox_events');
    const processed = c.columns.filter(
      (r: { table_name: string }) => r.table_name === 'processed_events',
    );
    expect(out.map((r: { column_name: string }) => r.column_name)).toEqual([
      'id',
      'event_id',
      'event_type',
      'aggregate_id',
      'payload',
      'correlation_id',
      'created_at',
      'published_at',
    ]);
    expect(out.map((r: { data_type: string }) => r.data_type)).toEqual([
      'bigint',
      'uuid',
      'text',
      'uuid',
      'jsonb',
      'uuid',
      'timestamp with time zone',
      'timestamp with time zone',
    ]);
    expect(out.map((r: { is_nullable: string }) => r.is_nullable)).toEqual([
      'NO',
      'NO',
      'NO',
      'NO',
      'NO',
      'NO',
      'NO',
      'YES',
    ]);
    expect(out[0]).toMatchObject({ is_identity: 'YES', identity_generation: 'ALWAYS' });
    expect(out[1].column_default).toBe('gen_random_uuid()');
    expect(out[6].column_default).toBe('clock_timestamp()');
    expect(out[7].column_default).toBeNull();
    expect(processed.map((r: { column_name: string }) => r.column_name)).toEqual([
      'consumer',
      'event_id',
      'processed_at',
    ]);
    expect(processed.map((r: { data_type: string }) => r.data_type)).toEqual([
      'text',
      'uuid',
      'timestamp with time zone',
    ]);
    expect(processed.every((r: { is_nullable: string }) => r.is_nullable === 'NO')).toBe(true);
    expect(processed[2].column_default).toBe('now()');
    const keys = await q(
      "SELECT conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('outbox_events'::regclass,'processed_events'::regclass) ORDER BY conname",
    );
    expect(keys).toEqual([
      { conname: 'outbox_events_event_id_key', contype: 'u', definition: 'UNIQUE (event_id)' },
      { conname: 'outbox_events_pkey', contype: 'p', definition: 'PRIMARY KEY (id)' },
      {
        conname: 'processed_events_pkey',
        contype: 'p',
        definition: 'PRIMARY KEY (consumer, event_id)',
      },
    ]);
  });
  it('TC-25-02 generated IDs, actual wall-clock defaults, unpublished NULL and string bigint', async () => {
    const [before] = await q('SELECT clock_timestamp() AS now');
    const [a] = await q(
      'INSERT INTO outbox_events(event_type,aggregate_id,payload,correlation_id) VALUES($1,$2,$3,$4) RETURNING *',
      event().slice(1),
    );
    const [b] = await q(
      'INSERT INTO outbox_events(event_type,aggregate_id,payload,correlation_id) VALUES($1,$2,$3,$4) RETURNING *',
      event().slice(1),
    );
    const [after] = await q('SELECT clock_timestamp() AS now');
    expect(typeof a.id).toBe('string');
    expect(BigInt(b.id)).toBeGreaterThan(BigInt(a.id));
    expect(a.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.event_id).not.toBe(b.event_id);
    expect(a.published_at).toBeNull();
    expect(a.created_at.getTime()).toBeGreaterThanOrEqual(before.now.getTime());
    expect(b.created_at.getTime()).toBeLessThanOrEqual(after.now.getTime());
  });
  it('TC-25-03 identity assignment and duplicate primary key', async () => {
    await rejects(
      'INSERT INTO outbox_events(id,event_id,event_type,aggregate_id,payload,correlation_id) VALUES(1,$1,$2,$3,$4,$5)',
      event(),
      '428C9',
    );
    const [a] = await q(INSERT, event());
    await rejects(
      'INSERT INTO outbox_events(id,event_id,event_type,aggregate_id,payload,correlation_id) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6)',
      [a.id, ...event()],
      '23505',
      { constraint: 'outbox_events_pkey' },
    );
  });
  it.each([
    'id',
    'event_id',
    'event_type',
    'aggregate_id',
    'payload',
    'correlation_id',
    'created_at',
  ])('TC-25-04 rejects SQL NULL %s', async column => {
    const values: Record<string, unknown> = {
      id: '99',
      event_id: randomUUID(),
      event_type: 'AccountStatusChanged',
      aggregate_id: randomUUID(),
      payload: { status: 'LOCKED' },
      correlation_id: randomUUID(),
      created_at: new Date(),
    };
    values[column] = null;
    await rejects(
      'INSERT INTO outbox_events(id,event_id,event_type,aggregate_id,payload,correlation_id,created_at) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7)',
      Object.values(values),
      '23502',
      { column },
    );
  });
  it('TC-25-05 event ID uniqueness but aggregate reuse allowed', async () => {
    const a = event();
    await q(INSERT, a);
    await rejects(INSERT, a, '23505', { constraint: 'outbox_events_event_id_key' });
    await q(INSERT, [randomUUID(), ...a.slice(1)]);
    expect(await rows()).toHaveLength(2);
  });
  it.each([0, 2, 3, 4])('TC-25-06 malformed UUID/JSON input %i', async index => {
    const a: unknown[] = event();
    a[index] = index === 3 ? '{broken' : 'invalid';
    await rejects(INSERT, a, '22P02');
  });
  it('TC-25-06 malformed processed event ID', async () => {
    await rejects(
      'INSERT INTO processed_events(consumer,event_id) VALUES($1,$2)',
      ['risk', 'invalid'],
      '22P02',
    );
  });
  it('TC-25-07 per-consumer deduplication, independent event IDs', async () => {
    const id = randomUUID();
    await q('INSERT INTO processed_events(consumer,event_id) VALUES($1,$2)', ['risk', id]);
    await rejects(
      'INSERT INTO processed_events(consumer,event_id) VALUES($1,$2)',
      ['risk', id],
      '23505',
      { constraint: 'processed_events_pkey' },
    );
    await q('INSERT INTO processed_events(consumer,event_id) VALUES($1,$2),($3,$4)', [
      'notification',
      id,
      'risk',
      randomUUID(),
    ]);
    expect(await q('SELECT * FROM processed_events')).toHaveLength(3);
  });
  it.each(['consumer', 'event_id', 'processed_at'])('TC-25-08 processed NULL %s', async column => {
    const a: Record<string, unknown> = {
      consumer: 'risk',
      event_id: randomUUID(),
      processed_at: new Date(),
    };
    a[column] = null;
    await rejects(
      'INSERT INTO processed_events(consumer,event_id,processed_at) VALUES($1,$2,$3)',
      Object.values(a),
      '23502',
      { column },
    );
  });
  it('TC-25-08 processed default equals transaction timestamp', async () => {
    await db.runner.startTransaction();
    const [r] = await q(
      "INSERT INTO processed_events(consumer,event_id) VALUES('risk',gen_random_uuid()) RETURNING processed_at=transaction_timestamp() AS same",
    );
    expect(r.same).toBe(true);
    await db.runner.rollbackTransaction();
  });
  it('TC-25-09 unknown types, unlinked UUIDs, JSON scalars/null and quote-bearing consumer stay open', async () => {
    for (const payload of ['null', '42', '"hello"'])
      await q(INSERT, [randomUUID(), 'FutureEvent', randomUUID(), payload, randomUUID()]);
    const consumer = "future'; DROP TABLE users; --";
    const [r] = await q(
      'INSERT INTO processed_events(consumer,event_id) VALUES($1,$2) RETURNING consumer',
      [consumer, randomUUID()],
    );
    expect(r.consumer).toBe(consumer);
    expect(await q("SELECT to_regclass('public.users') AS name")).toEqual([{ name: 'users' }]);
  });
  it('TC-25-10 exactly two partial indexes plus primary/unique indexes', async () => {
    const indexes = (await catalog()).indexes;
    expect(indexes.map((r: { indexname: string }) => r.indexname)).toEqual([
      'outbox_events_event_id_key',
      'outbox_events_pkey',
      'outbox_published_cleanup_idx',
      'outbox_unpublished_idx',
      'processed_events_pkey',
    ]);
    expect(
      indexes.find((r: { indexname: string }) => r.indexname === 'outbox_unpublished_idx').indexdef,
    ).toContain('USING btree (id) WHERE (published_at IS NULL)');
    expect(
      indexes.find((r: { indexname: string }) => r.indexname === 'outbox_published_cleanup_idx')
        .indexdef,
    ).toContain('USING btree (published_at) WHERE (published_at IS NOT NULL)');
  });
  it('TC-25-11 publish transitions and cleanup UPDATE/DELETE remain permitted', async () => {
    const [a] = await q(INSERT, event());
    expect(await q('SELECT id FROM outbox_events WHERE published_at IS NULL')).toEqual([
      { id: a.id },
    ]);
    await q('UPDATE outbox_events SET published_at=clock_timestamp() WHERE id=$1', [a.id]);
    expect(await q('SELECT id FROM outbox_events WHERE published_at IS NULL')).toEqual([]);
    expect(await q('SELECT id FROM outbox_events WHERE published_at IS NOT NULL')).toEqual([
      { id: a.id },
    ]);
    await q('DELETE FROM outbox_events WHERE id=$1', [a.id]);
    await q("INSERT INTO processed_events VALUES('risk',gen_random_uuid(),now())");
    await q('DELETE FROM processed_events');
    expect(await rows()).toEqual([]);
  });
  it('TC-25-12 technical event rows commit and roll back together', async () => {
    for (const commit of [false, true]) {
      await db.runner.startTransaction();
      await q(INSERT, event());
      await q("INSERT INTO processed_events(consumer,event_id) VALUES('risk',gen_random_uuid())");
      if (commit) await db.runner.commitTransaction();
      else await db.runner.rollbackTransaction();
      expect(await rows()).toHaveLength(commit ? 1 : 0);
      expect(await q('SELECT * FROM processed_events')).toHaveLength(commit ? 1 : 0);
    }
  });
  it('TC-25-13 production CLI run/revert/run preserves base objects', async () => {
    cli('migration:run', db.url);
    await revertSuccessors();
    cli('migration:revert', db.url);
    expect(await q("SELECT to_regclass('public.outbox_events') AS name")).toEqual([{ name: null }]);
    expect(await history()).toHaveLength(2);
    cli('migration:run', db.url);
    await revertSuccessors();
    expect(await history()).toHaveLength(3);
    expect(await rows()).toEqual([]);
    expect(await q('SELECT id,balance FROM accounts')).toEqual([
      { id: '00000000-0000-4000-8000-000000000001', balance: '0' },
    ]);
  });
  it.each(['unpublished', 'published', 'processed'])(
    'TC-25-14 nonempty %s refuses down and preserves catalog/rows/history',
    async kind => {
      if (kind === 'processed')
        await q("INSERT INTO processed_events(consumer,event_id) VALUES('risk',gen_random_uuid())");
      else {
        await q(INSERT, event());
        if (kind === 'published') await q('UPDATE outbox_events SET published_at=now()');
      }
      const before = {
        catalog: await catalog(),
        out: await rows(),
        processed: await q('SELECT * FROM processed_events'),
      };
      await expect(migrate(db.url, 'undoLast')).rejects.toMatchObject({
        driverError: { code: '55000' },
      });
      expect({
        catalog: await catalog(),
        out: await rows(),
        processed: await q('SELECT * FROM processed_events'),
      }).toEqual(before);
      await q(INSERT, event());
    },
  );
  it.each(['outbox_events', 'processed_events'])(
    'TC-25-15 writer commit while down waits on %s is never lost',
    async table => {
      const b = source.createQueryRunner();
      await b.connect();
      await b.startTransaction('READ COMMITTED');
      const [{ pid }] = await b.query('SELECT pg_backend_pid() AS pid');
      await db.runner.startTransaction();
      await q(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`);
      const pending = migration.down(b).then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await waitLock(pid);
        if (table === 'outbox_events') await q(INSERT, event());
        else
          await q(
            "INSERT INTO processed_events(consumer,event_id) VALUES('risk',gen_random_uuid())",
          );
        await db.runner.commitTransaction();
        expect(await pending).toMatchObject({ driverError: { code: '55000' } });
        await b.rollbackTransaction();
        expect(await q(`SELECT * FROM ${table}`)).toHaveLength(1);
        expect(await history()).toHaveLength(3);
      } finally {
        if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
        await pending;
        if (b.isTransactionActive) await b.rollbackTransaction();
        await b.release();
      }
    },
  );
  it('TC-25-16 atomic failed up leaves sentinel only; recovery succeeds', async () => {
    await migrate(db.url, 'undoLast');
    await q('CREATE TABLE processed_events(sentinel text)');
    await expect(migrateThrough(db.url, OUTBOX)).rejects.toMatchObject({
      driverError: { code: '42P07' },
    });
    expect(await q("SELECT to_regclass('public.outbox_events') AS name")).toEqual([{ name: null }]);
    expect(await history()).toHaveLength(2);
    expect(
      await q(
        "SELECT column_name FROM information_schema.columns WHERE table_name='processed_events'",
      ),
    ).toEqual([{ column_name: 'sentinel' }]);
    await q('DROP TABLE processed_events');
    await migrateThrough(db.url, OUTBOX);
    expect(await rows()).toEqual([]);
    expect(await history()).toHaveLength(3);
  });
  it('TC-25-17 down requires an active QueryRunner transaction', async () => {
    const before = await catalog();
    // Without the guard, LOCK TABLE outside a transaction also errors, so match the guard's message.
    await expect(migration.down(db.runner)).rejects.toThrow(
      'Reverting outbox requires a transaction',
    );
    expect(await catalog()).toEqual(before);
  });
  it('TC-25-17 down from an active transaction drops both empty tables and their indexes', async () => {
    await db.runner.startTransaction();
    await migration.down(db.runner);
    await db.runner.commitTransaction();
    expect(
      await q(
        "SELECT to_regclass('public.outbox_events') AS outbox, to_regclass('public.processed_events') AS processed",
      ),
    ).toEqual([{ outbox: null, processed: null }]);
    expect(
      await q(
        "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename IN ('outbox_events','processed_events')",
      ),
    ).toEqual([]);
  });
  it.each(['outbox_events', 'processed_events'])(
    'TC-25-20 stale RR snapshot cannot drop committed %s',
    async table => {
      await db.runner.startTransaction('REPEATABLE READ');
      await q(`SELECT * FROM ${table}`);
      if (table === 'outbox_events') await source.query(INSERT, event());
      else
        await source.query(
          "INSERT INTO processed_events(consumer,event_id) VALUES('risk',gen_random_uuid())",
        );
      await expect(migration.down(db.runner)).rejects.toMatchObject({
        driverError: { code: '55000' },
      });
      await db.runner.rollbackTransaction();
      expect(await q(`SELECT * FROM ${table}`)).toHaveLength(1);
      expect(await history()).toHaveLength(3);
    },
  );
  it('TC-25-20 empty tables revert in an explicit READ COMMITTED transaction', async () => {
    await db.runner.startTransaction('READ COMMITTED');
    expect(await q('SHOW transaction_isolation')).toEqual([
      { transaction_isolation: 'read committed' },
    ]);
    await migration.down(db.runner);
    await db.runner.commitTransaction();
    expect(
      await q(
        "SELECT to_regclass('public.outbox_events') AS outbox, to_regclass('public.processed_events') AS processed",
      ),
    ).toEqual([{ outbox: null, processed: null }]);
  });
  it.each(['READ UNCOMMITTED', 'SERIALIZABLE'] as const)(
    'TC-25-20 refuses unsafe isolation %s before DDL',
    async isolation => {
      const before = await catalog();
      await db.runner.startTransaction(isolation);
      await expect(migration.down(db.runner)).rejects.toMatchObject({
        driverError: { code: '55000' },
      });
      await db.runner.rollbackTransaction();
      expect(await catalog()).toEqual(before);
    },
  );
});
