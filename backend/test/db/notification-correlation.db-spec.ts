import { randomUUID } from 'node:crypto';
import {
  createTempDatabase,
  migrate,
  migrateThrough,
  type TempDatabase,
} from '../support/temp-database';

// The migration before DBS-134, so "up" below applies exactly the new one.
const BEFORE = 'CreateDbRolesAndGrants1793664000000';

/** DBS-134: notification_log carries the correlationId of the event that caused each notice. */
describe('DBS-134 notification_log.correlation_id migration (real PostgreSQL)', () => {
  let db: TempDatabase;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;
  const insertNotice = (eventId: string) =>
    q(
      `INSERT INTO notification_log(event_id,kind,user_id,message)
       VALUES($1,'account_status_changed',NULL,'Tài khoản của bạn đã được mở khóa')`,
      [eventId],
    );

  beforeEach(async () => {
    db = await createTempDatabase();
    await migrateThrough(db.url, BEFORE);
  });
  afterEach(async () => {
    await db?.drop();
  });

  it('TC-134-01 adds a nullable uuid column and backfills it from outbox_events by event_id', async () => {
    const linked = randomUUID();
    const orphan = randomUUID();
    const correlationId = randomUUID();
    await q(
      `INSERT INTO outbox_events(event_id,event_type,aggregate_id,payload,correlation_id)
       VALUES($1,'AccountStatusChanged',$2,'{}'::jsonb,$3)`,
      [linked, randomUUID(), correlationId],
    );
    await insertNotice(linked);
    await insertNotice(orphan);

    await migrate(db.url);

    const [column] = await q(
      `SELECT data_type,is_nullable FROM information_schema.columns
       WHERE table_name='notification_log' AND column_name='correlation_id'`,
    );
    expect(column).toEqual({ data_type: 'uuid', is_nullable: 'YES' });
    const rows = await q('SELECT event_id,correlation_id FROM notification_log ORDER BY id');
    expect(rows).toEqual([
      { event_id: linked, correlation_id: correlationId },
      { event_id: orphan, correlation_id: null },
    ]);
  });

  it('TC-134-02 down keeps the notices and drops the column; up applies again; dbs_worker can write it', async () => {
    await migrate(db.url);
    const correlationId = randomUUID();
    await q(
      `INSERT INTO notification_log(event_id,kind,user_id,message,correlation_id)
       VALUES($1,'account_status_changed',NULL,'x',$2)`,
      [randomUUID(), correlationId],
    );
    const [grant] = await q(
      `SELECT has_column_privilege('dbs_worker','notification_log','correlation_id','INSERT') AS can_insert,
              has_column_privilege('dbs_worker','notification_log','correlation_id','SELECT') AS can_select`,
    );
    expect(grant).toEqual({ can_insert: true, can_select: true });

    await migrate(db.url, 'undoLast');
    const columns = await q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='notification_log' AND column_name='correlation_id'`,
    );
    expect(columns).toEqual([]);
    expect(await q('SELECT count(*)::int AS n FROM notification_log')).toEqual([{ n: 1 }]);

    await migrate(db.url);
    const [after] = await q('SELECT correlation_id FROM notification_log');
    expect(after).toEqual({ correlation_id: null });
  });
});
