import {
  createTempDatabase,
  migrate,
  migrateThrough,
  type TempDatabase,
} from '../support/temp-database';

// Pinned: a later migration may exist, so "up" and undoLast must stop at this one.
const THIS = 'TuneTransfersAutovacuum1795000011000';

/**
 * DBS-173 (BL-413): `transfers` only ever receives inserts, so autovacuum runs because of the
 * insert threshold (1,000 rows plus 20% of the rows by default). On RDS that was every five to seven minutes, which
 * left 15% of the pages out of the visibility map and 39% of the rows of a busy account read from
 * the heap by an "index-only" scan, and made the planner prefer a sequential scan of the whole
 * table. The table is therefore vacuumed after every 1,000 inserts, whatever its size (scale factor 0).
 */
describe('transfers autovacuum parameters (DBS-173)', () => {
  let db: TempDatabase;

  const reloptions = async (): Promise<string[] | null> => {
    const rows = (await db.runner.query(
      `SELECT reloptions FROM pg_class WHERE oid = 'public.transfers'::regclass`,
    )) as { reloptions: string[] | null }[];
    return rows[0].reloptions;
  };

  beforeAll(async () => {
    db = await createTempDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('TC-173-07 migration:run sets the insert-driven vacuum parameters', async () => {
    await migrateThrough(db.url, THIS);
    expect(new Set(await reloptions())).toEqual(
      new Set([
        'autovacuum_vacuum_insert_scale_factor=0',
        'autovacuum_vacuum_insert_threshold=1000',
      ]),
    );
  });

  it('TC-173-07 migration:revert resets them (reloptions is NULL, not an empty array) and the data is untouched', async () => {
    await db.runner.query(
      `INSERT INTO users(id, cognito_sub) VALUES (gen_random_uuid(), 'sub-173')`,
    );
    await migrate(db.url, 'undoLast');
    expect(await reloptions()).toBeNull();
    const users = (await db.runner.query(`SELECT count(*)::int AS n FROM users`)) as {
      n: number;
    }[];
    expect(users[0].n).toBe(1);
  });

  it('TC-173-07 migration:run again restores them', async () => {
    await migrateThrough(db.url, THIS);
    expect((await reloptions())?.length).toBe(2);
  });
});
