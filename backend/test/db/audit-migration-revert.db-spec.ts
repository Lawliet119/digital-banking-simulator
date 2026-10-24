import { createTempDatabase, migrateThrough, type TempDatabase } from '../support/temp-database';

const FIRST = 'CreateUsersCustomersAccounts1791763200000';
const SECOND = 'CreateTransfersLedgerIdempotency1791849600000';

describe('audit migration: prefix regression', () => {
  let db: TempDatabase;
  beforeEach(async () => {
    db = await createTempDatabase();
  });
  afterEach(async () => {
    await db?.drop();
  });

  it('TC-26-20 selects real prefixes, is idempotent, and refuses unknown/gapped/older history without DDL', async () => {
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
