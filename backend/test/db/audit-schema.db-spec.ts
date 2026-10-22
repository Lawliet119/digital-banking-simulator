import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DataSource, type MigrationInterface } from 'typeorm';
import { createMigrationDataSource } from '@database/data-source';
import { createTempDatabase, migrate, attempt, type TempDatabase } from '../support/temp-database';

const TARGET = 'CreateAuditLog1792627200001';
const INSERT =
  'INSERT INTO audit_log(actor_user_id,actor_role,action,outcome,target_type,target_id,correlation_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *';
const values = (): unknown[] => [
  null,
  'system',
  'audit.search',
  'SUCCESS',
  'correlation',
  'missing-target',
  randomUUID(),
  { reason: 'ACCOUNT_NOT_ACTIVE' },
];

describe('audit storage migration', () => {
  let db: TempDatabase;
  let source: DataSource;
  let migration: MigrationInterface;
  beforeEach(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await createMigrationDataSource(db.url).initialize();
    migration = source.migrations.find(m => m.name === TARGET)!;
  });
  afterEach(async () => {
    if (db?.runner.isTransactionActive) await db.runner.rollbackTransaction();
    if (source?.isInitialized) await source.destroy();
    await db?.drop();
  });
  const q = (sql: string, params: unknown[] = []) => db.runner.query(sql, params);
  const rows = () => q('SELECT * FROM audit_log ORDER BY id');
  async function catalog() {
    return {
      columns: await q(
        "SELECT column_name,data_type,is_nullable,column_default,is_identity,identity_generation FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_log' ORDER BY ordinal_position",
      ),
      indexes: await q(
        "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='audit_log' ORDER BY indexname",
      ),
      history: await q('SELECT name,timestamp FROM migrations ORDER BY timestamp'),
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
      const [r] = await source.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [
        pid,
      ]);
      if (r?.wait_event_type === 'Lock') return;
    }
    throw new Error('Expected lock wait was not observed');
  }
  function cli(script: string) {
    execFileSync(process.execPath, [process.env.npm_execpath!, 'run', script], {
      cwd: resolve(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: db.url },
      stdio: 'pipe',
    });
  }

  it('TC-26-01 exact schema, defaults, named PK/FK/CHECK and unchanged base', async () => {
    const { columns } = await catalog();
    expect(columns.map((r: { column_name: string }) => r.column_name)).toEqual([
      'id',
      'occurred_at',
      'actor_user_id',
      'actor_role',
      'action',
      'outcome',
      'target_type',
      'target_id',
      'correlation_id',
      'metadata',
    ]);
    expect(columns.map((r: { data_type: string }) => r.data_type)).toEqual([
      'bigint',
      'timestamp with time zone',
      'uuid',
      'text',
      'text',
      'text',
      'text',
      'text',
      'uuid',
      'jsonb',
    ]);
    expect(columns.map((r: { is_nullable: string }) => r.is_nullable)).toEqual([
      'NO',
      'NO',
      'YES',
      'NO',
      'NO',
      'NO',
      'NO',
      'NO',
      'NO',
      'NO',
    ]);
    expect(columns[0]).toMatchObject({ is_identity: 'YES', identity_generation: 'ALWAYS' });
    expect(columns[1].column_default).toBe('clock_timestamp()');
    expect(columns[9].column_default).toBe("'{}'::jsonb");
    expect(
      columns
        .filter(
          (r: { column_name: string }) =>
            !['id', 'occurred_at', 'metadata'].includes(r.column_name),
        )
        .every((r: { column_default: unknown }) => r.column_default === null),
    ).toBe(true);
    const constraints = await q(
      "SELECT conname,contype,confdeltype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='audit_log'::regclass ORDER BY conname",
    );
    expect(constraints.map((r: { conname: string }) => r.conname)).toEqual([
      'audit_log_actor_user_id_fkey',
      'audit_log_outcome_check',
      'audit_log_pkey',
    ]);
    expect(constraints[0]).toMatchObject({
      contype: 'f',
      confdeltype: 'r',
      definition: 'FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT',
    });
    expect(constraints[2].definition).toBe('PRIMARY KEY (id)');
    expect(await q('SELECT id,balance FROM accounts')).toEqual([
      { id: '00000000-0000-4000-8000-000000000001', balance: '0' },
    ]);
  });
  it('TC-26-02 bigint identity survives above 2^53 with no gapless guarantee', async () => {
    const [a] = await q(INSERT, values());
    const [b] = await q(INSERT, values());
    expect(BigInt(b.id)).toBeGreaterThan(BigInt(a.id));
    await q("SELECT setval(pg_get_serial_sequence('audit_log','id'),9007199254740992,true)");
    const [large] = await q(INSERT, values());
    expect(large.id).toBe('9007199254740993');
  });
  it('TC-26-03 identity assignment, PK duplicate and overridden NULL are refused', async () => {
    await rejects(
      'INSERT INTO audit_log(id,actor_user_id,actor_role,action,outcome,target_type,target_id,correlation_id,metadata) VALUES(1,$1,$2,$3,$4,$5,$6,$7,$8)',
      values(),
      '428C9',
    );
    const [a] = await q(INSERT, values());
    const sql =
      'INSERT INTO audit_log(id,actor_user_id,actor_role,action,outcome,target_type,target_id,correlation_id,metadata) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)';
    await rejects(sql, [a.id, ...values()], '23505', { constraint: 'audit_log_pkey' });
    await rejects(sql, [null, ...values()], '23502', { column: 'id' });
  });
  it('TC-26-04 wall-clock default, UTC and supplied offset preserve instant', async () => {
    const [before] = await q('SELECT clock_timestamp() AS time');
    const [a] = await q(INSERT, values());
    const [after] = await q('SELECT clock_timestamp() AS time');
    expect(a.occurred_at.getTime()).toBeGreaterThanOrEqual(before.time.getTime());
    expect(a.occurred_at.getTime()).toBeLessThanOrEqual(after.time.getTime());
    expect((await q('SHOW timezone'))[0].TimeZone).toBe('UTC');
    const [r] = await q(
      "INSERT INTO audit_log(occurred_at,actor_role,action,outcome,target_type,target_id,correlation_id) VALUES('2026-10-22T10:00:00+07:00','system','audit.search','SUCCESS','correlation','absent',gen_random_uuid()) RETURNING occurred_at",
    );
    expect(r.occurred_at.toISOString()).toBe('2026-10-22T03:00:00.000Z');
  });
  it('TC-26-05 omitted/NULL/existing actor allowed; missing and deleting referenced user refused', async () => {
    const [system] = await q(
      "INSERT INTO audit_log(actor_role,action,outcome,target_type,target_id,correlation_id) VALUES('system','audit.search','SUCCESS','correlation','absent',gen_random_uuid()) RETURNING *",
    );
    expect(system.actor_user_id).toBeNull();
    expect((await q(INSERT, values()))[0].actor_user_id).toBeNull();
    const [user] = await q("INSERT INTO users(cognito_sub) VALUES('minh-local') RETURNING id");
    const a = values();
    a[0] = user.id;
    await q(INSERT, a);
    a[0] = randomUUID();
    await rejects(INSERT, a, '23503', { constraint: 'audit_log_actor_user_id_fkey' });
    await rejects('DELETE FROM users WHERE id=$1', [user.id], '23503', {
      constraint: 'audit_log_actor_user_id_fkey',
    });
  });
  it.each([
    'occurred_at',
    'actor_role',
    'action',
    'outcome',
    'target_type',
    'target_id',
    'correlation_id',
    'metadata',
  ])('TC-26-06 rejects NULL %s', async column => {
    const a: Record<string, unknown> = {
      occurred_at: new Date(),
      actor_role: 'system',
      action: 'audit.search',
      outcome: 'SUCCESS',
      target_type: 'correlation',
      target_id: 'absent',
      correlation_id: randomUUID(),
      metadata: {},
    };
    a[column] = null;
    await rejects(
      'INSERT INTO audit_log(occurred_at,actor_role,action,outcome,target_type,target_id,correlation_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      Object.values(a),
      '23502',
      { column },
    );
  });
  it.each(['SUCCESS', 'REJECTED', 'DENIED'])('TC-26-07 stores outcome %s', async outcome => {
    const a = values();
    a[3] = outcome;
    expect((await q(INSERT, a))[0].outcome).toBe(outcome);
  });
  it.each(['FAILED', 'success', ''])('TC-26-08 rejects invalid outcome %s', async outcome => {
    const a = values();
    a[3] = outcome;
    await rejects(INSERT, a, '23514', { constraint: 'audit_log_outcome_check' });
  });
  it('TC-26-09 target and role/action/type remain text, metadata object/scalar/null accepted and default empty', async () => {
    const [r] = await q(
      "INSERT INTO audit_log(actor_role,action,outcome,target_type,target_id,correlation_id) VALUES('future-role','future-action','DENIED','future-type','account-not-present',gen_random_uuid()) RETURNING *",
    );
    expect(r.metadata).toEqual({});
    expect(r.target_id).toBe('account-not-present');
    for (const metadata of ['42', 'null', '{"reason":"ACCOUNT_NOT_ACTIVE"}']) {
      const a = values();
      a[7] = metadata;
      expect((await q(INSERT, a))[0].metadata).toEqual(JSON.parse(metadata));
    }
  });
  it.each([0, 6, 7])(
    'TC-26-10 malformed UUID/JSON %i rejects then connection recovers',
    async index => {
      const a = values();
      a[index] = index === 7 ? '{broken' : 'bad';
      await rejects(INSERT, a, '22P02');
      expect(await q(INSERT, values())).toHaveLength(1);
    },
  );
  it('TC-26-11 exact nonunique B-tree index definitions and no extras', async () => {
    const { indexes } = await catalog();
    expect(indexes.map((r: { indexname: string }) => r.indexname)).toEqual([
      'audit_log_action_occurred_idx',
      'audit_log_actor_occurred_idx',
      'audit_log_correlation_idx',
      'audit_log_pkey',
    ]);
    for (const [name, key] of [
      ['audit_log_correlation_idx', '(correlation_id)'],
      ['audit_log_actor_occurred_idx', '(actor_user_id, occurred_at DESC)'],
      ['audit_log_action_occurred_idx', '(action, occurred_at DESC)'],
    ]) {
      const r = indexes.find((x: { indexname: string }) => x.indexname === name);
      expect(r.indexdef).toBe(`CREATE INDEX ${name} ON public.audit_log USING btree ${key}`);
    }
  });
  it('TC-26-12 correlation, actor and action filters with descending timestamps', async () => {
    const [user] = await q("INSERT INTO users(cognito_sub) VALUES('lan-local') RETURNING id");
    const correlation = randomUUID();
    const ids: string[] = [];
    for (const time of ['2026-10-22T01:00:00Z', '2026-10-22T02:00:00Z']) {
      const [r] = await q(
        "INSERT INTO audit_log(occurred_at,actor_user_id,actor_role,action,outcome,target_type,target_id,correlation_id) VALUES($1,$2,'operator','audit.search','SUCCESS','correlation','absent',$3) RETURNING id",
        [time, user.id, correlation],
      );
      ids.push(r.id);
    }
    const other = values();
    other[2] = 'account.lock';
    await q(INSERT, other);
    for (const [filter, value] of [
      ['correlation_id', correlation],
      ['actor_user_id', user.id],
      ['action', 'audit.search'],
    ]) {
      expect(
        (
          await q(`SELECT id FROM audit_log WHERE ${filter}=$1 ORDER BY occurred_at DESC`, [value])
        ).map((r: { id: string }) => r.id),
      ).toEqual(ids.slice().reverse());
    }
  });
  it('TC-26-13 CLI run/revert/run removes only audit storage and restores it', async () => {
    const before = await catalog();
    cli('migration:revert');
    expect((await catalog()).columns).toEqual([]);
    expect((await catalog()).history).toHaveLength(2);
    expect(await q("SELECT to_regclass('public.audit_log_id_seq') AS name")).toEqual([
      { name: null },
    ]);
    cli('migration:run');
    expect(await catalog()).toEqual(before);
  });
  it.each([false, true])(
    'TC-26-14 committed audit actor=%s makes revert preserve every row and catalog',
    async withUser => {
      const a = values();
      if (withUser) {
        const [user] = await q("INSERT INTO users(cognito_sub) VALUES('minh-local') RETURNING id");
        a[0] = user.id;
      }
      await q(INSERT, a);
      const before = { catalog: await catalog(), rows: await rows() };
      await expect(migrate(db.url, 'undoLast')).rejects.toMatchObject({
        driverError: { code: '55000' },
      });
      expect({ catalog: await catalog(), rows: await rows() }).toEqual(before);
    },
  );
  it('TC-26-15 commit by a writer while down waits is preserved', async () => {
    const b = source.createQueryRunner();
    await b.connect();
    await b.startTransaction('READ COMMITTED');
    const [{ pid }] = await b.query('SELECT pg_backend_pid() AS pid');
    await db.runner.startTransaction();
    await q(INSERT, values());
    const pending = migration.down(b).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await waitLock(pid);
      await db.runner.commitTransaction();
      expect(await pending).toMatchObject({ driverError: { code: '55000' } });
      await b.rollbackTransaction();
      expect(await rows()).toHaveLength(1);
      expect((await catalog()).history).toHaveLength(3);
    } finally {
      if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
      await pending;
      if (b.isTransactionActive) await b.rollbackTransaction();
      await b.release();
    }
  });
  it('TC-26-16 writer blocked behind down is cancelled; retry after DROP cannot insert', async () => {
    const b = source.createQueryRunner();
    await b.connect();
    await b.startTransaction();
    const [{ pid }] = await b.query('SELECT pg_backend_pid() AS pid');
    await db.runner.startTransaction('READ COMMITTED');
    await migration.down(db.runner);
    const pending = b.query(INSERT, values()).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await waitLock(pid);
      await source.query('SELECT pg_cancel_backend($1)', [pid]);
      expect(await pending).toMatchObject({ driverError: { code: '57014' } });
      await b.rollbackTransaction();
      await db.runner.commitTransaction();
      await expect(b.query(INSERT, values())).rejects.toMatchObject({
        driverError: { code: '42P01' },
      });
    } finally {
      if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
      await pending;
      if (b.isTransactionActive) await b.rollbackTransaction();
      await b.release();
    }
  });
  it('TC-26-17 failed up is atomic and recovers after conflicting index is removed', async () => {
    await migrate(db.url, 'undoLast');
    await q('CREATE TABLE audit_sentinel(id int)');
    await q('CREATE INDEX audit_log_actor_occurred_idx ON audit_sentinel(id)');
    await expect(migrate(db.url)).rejects.toMatchObject({ driverError: { code: '42P07' } });
    expect((await catalog()).columns).toEqual([]);
    expect((await catalog()).history).toHaveLength(2);
    expect(await q("SELECT to_regclass('public.audit_log_actor_occurred_idx') AS name")).toEqual([
      { name: 'audit_log_actor_occurred_idx' },
    ]);
    await q('DROP TABLE audit_sentinel');
    await migrate(db.url);
    expect((await catalog()).columns).toHaveLength(10);
  });
  it('TC-26-19 hostile input is bound, stored verbatim and never executed', async () => {
    const hostile = "'; DROP TABLE users; --";
    const a = values();
    a[2] = hostile;
    a[5] = hostile;
    const [r] = await q(INSERT, a);
    expect(r.action).toBe(hostile);
    expect(r.target_id).toBe(hostile);
    expect(await q("SELECT to_regclass('public.users') AS name")).toEqual([{ name: 'users' }]);
  });
  it('TC-26-21 no active transaction refuses before DDL', async () => {
    const before = await catalog();
    await expect(migration.down(db.runner)).rejects.toMatchObject({ code: '55000' });
    expect(await catalog()).toEqual(before);
  });
  it.each(['REPEATABLE READ', 'SERIALIZABLE', 'READ UNCOMMITTED'] as const)(
    'TC-26-21 isolation %s refuses before DDL',
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
  it('TC-26-22 an old repeatable-read snapshot cannot hide a committed audit', async () => {
    await db.runner.startTransaction('REPEATABLE READ');
    expect(await rows()).toEqual([]);
    await source.query(INSERT, values());
    await expect(migration.down(db.runner)).rejects.toMatchObject({
      driverError: { code: '55000' },
    });
    await db.runner.rollbackTransaction();
    expect(await rows()).toHaveLength(1);
    expect((await catalog()).history).toHaveLength(3);
  });
});
