import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { type DataSource, type MigrationInterface } from 'typeorm';
import { createMigrationDataSource } from '@database/data-source';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

const TARGET = 'CreateReconciliationRuns1793577600000';
const INSERT =
  "INSERT INTO public.reconciliation_runs(started_at,status) VALUES($1,'OK') RETURNING id";
const START = '2026-11-03T01:00:00Z';

describe('reconciliation migration lifecycle and concurrent revert', () => {
  let db: TempDatabase;
  let source: DataSource;
  let initialHistory: { name: string; timestamp: string }[];
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    db.runner.query(sql, params) as Promise<T[]>;
  const history = () =>
    q<{ name: string; timestamp: string }>(
      'SELECT name,timestamp FROM migrations ORDER BY timestamp,id',
    );
  function target(): MigrationInterface {
    const result = source.migrations.find(m => m.name === TARGET);
    expect(result).toBeDefined();
    return result!;
  }
  async function catalog() {
    return {
      columns: await q(
        "SELECT column_name,data_type,is_nullable,column_default,is_identity FROM information_schema.columns WHERE table_schema='public' AND table_name='reconciliation_runs' ORDER BY ordinal_position",
      ),
      constraints: await q(
        "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass('public.reconciliation_runs') ORDER BY conname",
      ),
      sequences: await q(
        "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' AND sequencename='reconciliation_runs_id_seq'",
      ),
      history: await history(),
      funding: await q('SELECT id,type,balance FROM accounts ORDER BY id'),
    };
  }
  function cli(script: string, expectedFailure = false) {
    expect(process.env.npm_execpath).toBeDefined();
    let status = 0;
    try {
      execFileSync(process.execPath, [process.env.npm_execpath!, 'run', script], {
        cwd: resolve(__dirname, '../..'),
        env: { ...process.env, DATABASE_URL: db.url },
        stdio: 'pipe',
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch (error) {
      const child = error as { status?: number; signal?: string };
      expect(child.signal).toBeNull();
      expect(typeof child.status).toBe('number');
      status = child.status!;
    }
    if (expectedFailure) expect(status).not.toBe(0);
    else expect(status).toBe(0);
  }
  async function waitForLock(pid?: number): Promise<number> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const rows = await source.query<{ pid: number }[]>(
        "SELECT pid FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND ($2::int IS NULL OR pid=$2) AND ($2::int IS NOT NULL OR query LIKE 'LOCK TABLE public.reconciliation_runs%')",
        [db.name, pid ?? null],
      );
      if (rows.length === 1) return rows[0].pid;
    }
    throw new Error('Expected reconciliation relation lock wait was not observed');
  }

  beforeEach(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await createMigrationDataSource(db.url).initialize();
    initialHistory = await history();
  });
  afterEach(async () => {
    if (db?.runner.isTransactionActive) await db.runner.rollbackTransaction();
    if (source?.isInitialized) await source.destroy();
    await db?.drop();
  });

  it('TC-116-18 CLI run/run/revert/run is idempotent and preserves the earlier schema', async () => {
    expect(initialHistory.at(-1)?.name).toBe(TARGET);
    const before = await catalog();
    cli('migration:run');
    cli('migration:run');
    expect(await catalog()).toEqual(before);
    cli('migration:revert');
    expect(
      await q(
        "SELECT to_regclass('public.reconciliation_runs') AS table_name,to_regclass('public.reconciliation_runs_id_seq') AS sequence_name",
      ),
    ).toEqual([{ table_name: null, sequence_name: null }]);
    expect(await history()).toEqual(initialHistory.slice(0, -1));
    for (const name of [
      'users',
      'customers',
      'accounts',
      'transfers',
      'ledger_entries',
      'idempotency_keys',
      'outbox_events',
      'audit_log',
    ]) {
      expect(await q('SELECT to_regclass($1) AS name', [`public.${name}`])).toEqual([{ name }]);
    }
    cli('migration:run');
    expect(await catalog()).toEqual(before);
  });
  it('TC-116-19 committed rows make CLI and migration down fail without losing data or history', async () => {
    await q(INSERT, [START]);
    const before = {
      catalog: await catalog(),
      rows: await q('SELECT * FROM reconciliation_runs ORDER BY id'),
    };
    cli('migration:revert', true);
    await expect(migrate(db.url, 'undoLast')).rejects.toMatchObject({
      driverError: { code: '55000' },
    });
    expect({
      catalog: await catalog(),
      rows: await q('SELECT * FROM reconciliation_runs ORDER BY id'),
    }).toEqual(before);
  });
  it.each([
    { id: '20', commit: true },
    { id: '21', commit: false },
  ])('TC-116-$id a writer commit=$commit while revert waits is respected', async ({ commit }) => {
    expect(initialHistory.at(-1)?.name).toBe(TARGET);
    await db.runner.startTransaction('READ COMMITTED');
    const [{ pid: writerPid }] = await q<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await q(INSERT, [START]);
    const pending = source.undoLastMigration({ transaction: 'all' }).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      const blockedPid = await waitForLock();
      const [{ blockers }] = await source.query<{ blockers: number[] }[]>(
        'SELECT pg_blocking_pids($1) AS blockers',
        [blockedPid],
      );
      expect(blockers).toContain(writerPid);
      if (commit) await db.runner.commitTransaction();
      else await db.runner.rollbackTransaction();
      const result = await pending;
      if (commit) {
        expect(result).toMatchObject({ driverError: { code: '55000' } });
        expect(await q('SELECT id FROM reconciliation_runs')).toHaveLength(1);
        expect(await history()).toEqual(initialHistory);
      } else {
        expect(result).toBeNull();
        expect(await q("SELECT to_regclass('public.reconciliation_runs') AS name")).toEqual([
          { name: null },
        ]);
        expect(await history()).toEqual(initialHistory.slice(0, -1));
        await migrate(db.url);
        expect(await q('SELECT * FROM reconciliation_runs')).toEqual([]);
        expect(await history()).toEqual(initialHistory);
      }
    } finally {
      if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
      await pending;
    }
  });
  it('TC-116-22 a writer blocked behind down cannot insert after DROP commits', async () => {
    const migration = target();
    const writer = source.createQueryRunner();
    await writer.connect();
    await writer.startTransaction('READ COMMITTED');
    const [{ pid }] = (await writer.query('SELECT pg_backend_pid() AS pid')) as { pid: number }[];
    await db.runner.startTransaction('READ COMMITTED');
    await migration.down(db.runner);
    const pending = writer.query(INSERT, [START]).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await waitForLock(pid);
      await db.runner.commitTransaction();
      expect(await pending).toMatchObject({ driverError: { code: '42P01' } });
      await writer.rollbackTransaction();
      await expect(writer.query(INSERT, [START])).rejects.toMatchObject({
        driverError: { code: '42P01' },
      });
    } finally {
      if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
      await pending;
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release();
    }
  });
  it('TC-116-23 down without a transaction refuses before DDL', async () => {
    const before = await catalog();
    await expect(target().down(db.runner)).rejects.toMatchObject({ code: '55000' });
    expect(await catalog()).toEqual(before);
  });
  it.each(['REPEATABLE READ', 'SERIALIZABLE', 'READ UNCOMMITTED'] as const)(
    'TC-116-23 isolation %s cannot use an older snapshot to hide a committed result',
    async isolation => {
      await db.runner.startTransaction(isolation);
      expect(await q('SELECT * FROM reconciliation_runs')).toEqual([]);
      await source.query(INSERT, [START]);
      await expect(target().down(db.runner)).rejects.toMatchObject({
        driverError: { code: '55000' },
      });
      await db.runner.rollbackTransaction();
      expect(await q('SELECT * FROM reconciliation_runs')).toHaveLength(1);
      expect(await history()).toEqual(initialHistory);
    },
  );
  it('TC-116-24 direct down/up in READ COMMITTED works on an empty table', async () => {
    const before = await catalog();
    await db.runner.startTransaction('READ COMMITTED');
    await target().down(db.runner);
    expect(await q("SELECT to_regclass('public.reconciliation_runs') AS name")).toEqual([
      { name: null },
    ]);
    await target().up(db.runner);
    await db.runner.commitTransaction();
    expect(await catalog()).toEqual(before);
  });
  it('TC-116-25 conflicting pre-existing table makes up atomic and recovers when the fixture is removed', async () => {
    expect(initialHistory.at(-1)?.name).toBe(TARGET);
    await source.undoLastMigration({ transaction: 'all' });
    const beforeHistory = await history();
    const beforeFunding = await q('SELECT id,type,balance FROM accounts ORDER BY id');
    await q('CREATE TABLE public.reconciliation_runs(sentinel text NOT NULL)');
    await q('INSERT INTO public.reconciliation_runs(sentinel) VALUES($1)', ['keep']);
    await expect(migrate(db.url)).rejects.toMatchObject({ driverError: { code: '42P07' } });
    expect(await history()).toEqual(beforeHistory);
    expect(await q('SELECT * FROM public.reconciliation_runs')).toEqual([{ sentinel: 'keep' }]);
    expect(await q('SELECT id,type,balance FROM accounts ORDER BY id')).toEqual(beforeFunding);
    await q('DROP TABLE public.reconciliation_runs');
    await migrate(db.url);
    expect(await history()).toEqual(initialHistory);
    expect((await catalog()).columns).toHaveLength(9);
  });
});
