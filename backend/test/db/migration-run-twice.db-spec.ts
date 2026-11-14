import type { MigrationInterface, QueryRunner } from 'typeorm';
import { createMigrationDataSource } from '@database/data-source';
import {
  createTempDatabase,
  migrate,
  migrateThrough,
  type TempDatabase,
} from '../support/temp-database';

/**
 * BL-110 (a), TC-68-17: what the deploy step relies on, proved on real PostgreSQL with the same
 * DataSource factory the CLI uses (`createMigrationDataSource`) and `transaction: 'all'`, the mode
 * of `migration:run` (DBS-68, docs/features/DBS-68-migration-step.md):
 *  - a second run in a row finds nothing pending, changes nothing and does not fail (the pipeline
 *    runs the migrate task on every deploy);
 *  - a migration that fails stops the run with its own error, and the whole run is rolled back:
 *    the `migrations` table and the schema stay exactly as they were, even for the valid migrations
 *    that ran earlier in the same run.
 */
const PREFIX = 'CreateTransfersLedgerIdempotency1791849600000';

/** Valid DDL first, then an error: what a typo at the end of a deploy's migration batch looks like. */
class FailingProbe9999999999999 implements MigrationInterface {
  name = 'FailingProbe9999999999999';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('CREATE TABLE bl110_probe (id int)');
    await runner.query('SELECT 1 / 0');
  }
  async down(): Promise<void> {
    // never applied
  }
}

describe('BL-110(a) createMigrationDataSource against PostgreSQL', () => {
  let db: TempDatabase;
  const q = <T = Record<string, unknown>>(sql: string) => db.runner.query(sql) as Promise<T[]>;
  const applied = () => q<{ name: string }>('SELECT name FROM migrations ORDER BY id');

  beforeEach(async () => {
    db = await createTempDatabase();
  });
  afterEach(async () => {
    await db?.drop();
  });

  it('TC-110-01 a second run in a row applies nothing, changes nothing and does not throw', async () => {
    const first = createMigrationDataSource(db.url);
    await first.initialize();
    let firstRun: unknown[];
    try {
      firstRun = await first.runMigrations({ transaction: 'all' });
    } finally {
      await first.destroy();
    }
    expect(firstRun.length).toBeGreaterThan(1);
    const afterFirst = await q('SELECT id, "timestamp", name FROM migrations ORDER BY id');
    expect(afterFirst).toHaveLength(firstRun.length);

    const second = createMigrationDataSource(db.url);
    await second.initialize();
    try {
      await expect(second.runMigrations({ transaction: 'all' })).resolves.toEqual([]);
      expect(await second.showMigrations()).toBe(false); // none pending
    } finally {
      await second.destroy();
    }
    expect(await q('SELECT id, "timestamp", name FROM migrations ORDER BY id')).toEqual(afterFirst);
  });

  it('TC-110-02 a failing migration rolls the whole run back and leaves the migrations table as it was', async () => {
    await migrateThrough(db.url, PREFIX);
    const before = await applied();
    expect(before.length).toBeGreaterThan(0);
    const tablesBefore = await q(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );

    const source = createMigrationDataSource(db.url);
    await source.initialize();
    try {
      // All the real migrations after the prefix are pending too and run first, in the same transaction.
      const pending = source.migrations.length - before.length;
      expect(pending).toBeGreaterThan(0);
      source.migrations.push(new FailingProbe9999999999999());
      await expect(source.runMigrations({ transaction: 'all' })).rejects.toMatchObject({
        code: '22012', // division_by_zero, from the injected migration itself
      });
    } finally {
      await source.destroy();
    }

    expect(await applied()).toEqual(before);
    expect(
      await q(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
      ),
    ).toEqual(tablesBefore);
    expect(await q("SELECT to_regclass('public.bl110_probe') AS probe")).toEqual([{ probe: null }]);

    // The failure leaves nothing behind that stops the next, healthy run.
    await migrate(db.url);
    expect((await applied()).length).toBeGreaterThan(before.length);
  });
});
