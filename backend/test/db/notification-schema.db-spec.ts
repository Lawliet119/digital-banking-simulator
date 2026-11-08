import { randomUUID } from 'node:crypto';
import {
  createTempDatabase,
  migrate,
  migrateThrough,
  attempt,
  type TempDatabase,
} from '../support/temp-database';

// Pinned so a later migration never becomes the "last" one that undoLast reverts.
const TARGET = 'CreateNotificationLog1792886400000';

describe('DBS-96 notification storage', () => {
  let db: TempDatabase;
  beforeEach(async () => {
    db = await createTempDatabase();
    await migrateThrough(db.url, TARGET);
  });
  afterEach(async () => {
    if (db?.runner.isTransactionActive) await db.runner.rollbackTransaction();
    await db?.drop();
  });
  const insert =
    'INSERT INTO notification_log(event_id,kind,user_id,message) VALUES($1,$2,$3,$4) RETURNING *';

  it('TC-96-01/02 schema and real inserts allow both kinds, nullable user and repeated event', async () => {
    const columns = await db.runner.query(
      "SELECT column_name,data_type,is_nullable,is_identity,identity_generation,column_default FROM information_schema.columns WHERE table_name='notification_log' ORDER BY ordinal_position",
    );
    expect(columns.map((c: { column_name: string }) => c.column_name)).toEqual([
      'id',
      'event_id',
      'kind',
      'user_id',
      'message',
      'created_at',
    ]);
    expect(columns[0]).toMatchObject({
      data_type: 'bigint',
      is_identity: 'YES',
      identity_generation: 'ALWAYS',
    });
    expect(columns.map((c: { data_type: string }) => c.data_type)).toEqual([
      'bigint',
      'uuid',
      'text',
      'uuid',
      'text',
      'timestamp with time zone',
    ]);
    const constraints = await db.runner.query(
      "SELECT conname,contype,confdeltype FROM pg_constraint WHERE conrelid='notification_log'::regclass",
    );
    expect(constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conname: 'notification_log_pkey', contype: 'p' }),
        expect.objectContaining({ conname: 'notification_log_kind_check', contype: 'c' }),
        expect.objectContaining({
          conname: 'notification_log_user_id_fkey',
          contype: 'f',
          confdeltype: 'r',
        }),
      ]),
    );
    expect(columns.map((c: { is_nullable: string }) => c.is_nullable)).toEqual([
      'NO',
      'NO',
      'NO',
      'YES',
      'NO',
      'NO',
    ]);
    expect(columns[5]).toMatchObject({
      data_type: 'timestamp with time zone',
      column_default: 'now()',
    });
    const indexes = await db.runner.query(
      "SELECT indexdef FROM pg_indexes WHERE tablename='notification_log' AND indexname='notification_log_event_id_idx'",
    );
    expect(indexes[0].indexdef).toContain('(event_id)');
    expect(indexes[0].indexdef).not.toContain('UNIQUE');
    const [comment] = await db.runner.query(
      "SELECT col_description('notification_log'::regclass,6-1) AS text",
    );
    expect(comment.text).toContain('BR-13');
    const [user] = await db.runner.query('INSERT INTO users(cognito_sub) VALUES($1) RETURNING id', [
      randomUUID(),
    ]);
    const event = randomUUID();
    const [a] = await db.runner.query(insert, [
      event,
      'transfer_completed',
      null,
      'Giao dich da hoan tat',
    ]);
    const [b] = await db.runner.query(insert, [
      event,
      'account_status_changed',
      user.id,
      'Trang thai tai khoan da thay doi',
    ]);
    expect(BigInt(b.id)).toBeGreaterThan(BigInt(a.id));
    expect(a.created_at).toBeInstanceOf(Date);
    expect(b.user_id).toBe(user.id);
  });

  it('TC-96-03 rejects invalid kind, missing fields, missing user and explicit identity', async () => {
    for (const [args, error] of [
      [
        [randomUUID(), 'other', null, 'Thong bao'],
        { code: '23514', constraint: 'notification_log_kind_check' },
      ],
      [[null, 'transfer_completed', null, 'Thong bao'], { code: '23502', column: 'event_id' }],
      [[randomUUID(), null, null, 'Thong bao'], { code: '23502', column: 'kind' }],
      [[randomUUID(), 'transfer_completed', null, null], { code: '23502', column: 'message' }],
      [
        [randomUUID(), 'transfer_completed', randomUUID(), 'Thong bao'],
        { code: '23503', constraint: 'notification_log_user_id_fkey' },
      ],
    ] as const) {
      await db.runner.startTransaction();
      await expect(attempt(db.runner, insert, [...args])).rejects.toMatchObject({
        driverError: error,
      });
      await db.runner.rollbackTransaction();
    }
    await expect(
      db.runner.query(
        "INSERT INTO notification_log(id,event_id,kind,message) VALUES(1,$1,'transfer_completed','Thong bao')",
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ driverError: { code: '428C9' } });
  });

  it('TC-96-03 prevents deletion of a referenced user', async () => {
    const [user] = await db.runner.query('INSERT INTO users(cognito_sub) VALUES($1) RETURNING id', [
      randomUUID(),
    ]);
    await db.runner.query(insert, [
      randomUUID(),
      'transfer_completed',
      user.id,
      'Giao dich da hoan tat',
    ]);
    await expect(db.runner.query('DELETE FROM users WHERE id=$1', [user.id])).rejects.toMatchObject(
      { driverError: { code: '23503', constraint: 'notification_log_user_id_fkey' } },
    );
  });

  it('TC-96-04 reverts and reruns without changing earlier tables/history, and refuses when rows exist', async () => {
    const history = await db.runner.query('SELECT name FROM migrations ORDER BY id');
    await db.runner.query(insert, [
      randomUUID(),
      'transfer_completed',
      null,
      'Giao dich da hoan tat',
    ]);
    await expect(migrate(db.url, 'undoLast')).rejects.toThrow(
      /Refusing to revert notification_log/,
    );
    await db.runner.query('DELETE FROM notification_log');
    await migrate(db.url, 'undoLast');
    expect(await db.runner.query("SELECT to_regclass('notification_log') AS name")).toEqual([
      { name: null },
    ]);
    expect(await db.runner.query("SELECT to_regclass('users') AS name")).toEqual([
      { name: 'users' },
    ]);
    expect(await db.runner.query('SELECT name FROM migrations ORDER BY id')).toEqual(
      history.slice(0, -1),
    );
    await migrateThrough(db.url, TARGET);
    expect(await db.runner.query('SELECT name FROM migrations ORDER BY id')).toEqual(history);
    expect(await db.runner.query('SELECT count(*)::int AS n FROM notification_log')).toEqual([
      { n: 0 },
    ]);
  });
});
