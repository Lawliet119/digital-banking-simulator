import { randomUUID } from 'node:crypto';
import {
  createTempDatabase,
  migrate,
  migrateThrough,
  type TempDatabase,
} from '../support/temp-database';

// The migration before BL-211, so "up" below applies exactly the new one.
const BEFORE = 'QuarantineOutboxEvents1795000009000';
// Pinned: a later migration may exist, so "up" and undoLast must stop at this one.
const THIS = 'AddNotificationLogOccurredAt1795000010000';

/** BL-211: notification_log orders by when the event happened, not when a worker got to it. */
describe('BL-211 notification_log.occurred_at migration (real PostgreSQL)', () => {
  let db: TempDatabase;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;
  const insertAt = (createdAt: string) =>
    q(
      `INSERT INTO notification_log(event_id,kind,user_id,message,created_at)
       VALUES($1,'account_status_changed',NULL,'x',$2) RETURNING id`,
      [randomUUID(), createdAt],
    );

  beforeEach(async () => {
    db = await createTempDatabase();
    await migrateThrough(db.url, BEFORE);
  });
  afterEach(async () => {
    await db?.drop();
  });

  it('TC-211-03 adds occurred_at timestamptz NOT NULL and backfills existing rows from created_at', async () => {
    await insertAt('2026-10-01T08:00:00.000Z');
    await insertAt('2026-10-02T09:30:00.500Z');

    await migrateThrough(db.url, THIS);

    const [column] = await q(
      `SELECT data_type,is_nullable FROM information_schema.columns
       WHERE table_name='notification_log' AND column_name='occurred_at'`,
    );
    expect(column).toEqual({ data_type: 'timestamp with time zone', is_nullable: 'NO' });
    const rows = (await q('SELECT occurred_at, created_at FROM notification_log ORDER BY id')) as {
      occurred_at: Date;
      created_at: Date;
    }[];
    expect(rows.map(r => r.occurred_at.toISOString())).toEqual([
      '2026-10-01T08:00:00.000Z',
      '2026-10-02T09:30:00.500Z',
    ]);
    expect(rows.map(r => r.occurred_at.getTime())).toEqual(rows.map(r => r.created_at.getTime()));
  });

  it('TC-211-04 a writer that does not know the column yet (old worker during a rolling deploy) still inserts', async () => {
    await migrateThrough(db.url, THIS);
    const [row] = await q(
      `INSERT INTO notification_log(event_id,kind,user_id,message)
       VALUES($1,'account_status_changed',NULL,'x') RETURNING occurred_at, created_at`,
      [randomUUID()],
    );
    expect((row.occurred_at as Date).getTime()).toBe((row.created_at as Date).getTime());
  });

  it('TC-211-05 dbs_worker may write and read occurred_at; down keeps the notices and drops the column; up applies again', async () => {
    await migrateThrough(db.url, THIS);
    const [grant] = await q(
      `SELECT has_column_privilege('dbs_worker','notification_log','occurred_at','INSERT') AS can_insert,
              has_column_privilege('dbs_worker','notification_log','occurred_at','SELECT') AS can_select`,
    );
    expect(grant).toEqual({ can_insert: true, can_select: true });
    await q(
      `INSERT INTO notification_log(event_id,kind,user_id,message,occurred_at)
       VALUES($1,'account_status_changed',NULL,'x','2026-01-01T00:00:00Z')`,
      [randomUUID()],
    );

    await migrate(db.url, 'undoLast');
    expect(
      await q(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='notification_log' AND column_name='occurred_at'`,
      ),
    ).toEqual([]);
    expect(await q('SELECT count(*)::int AS n FROM notification_log')).toEqual([{ n: 1 }]);

    await migrateThrough(db.url, THIS);
    const [after] = (await q('SELECT occurred_at, created_at FROM notification_log')) as {
      occurred_at: Date;
      created_at: Date;
    }[];
    expect(after.occurred_at.getTime()).toBe(after.created_at.getTime());
  });
});
