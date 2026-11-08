import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import {
  OUTBOX_BATCH_SQL,
  OutboxCleanupService,
  PROCESSED_BATCH_SQL,
} from '@modules/outbox/outbox-cleanup.service';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/**
 * DBS-92: the outbox cleanup job against real PostgreSQL: small batches, never an unpublished
 * row, own retention for the dedup marks, the index in the plan, no lock held between batches.
 */
describe('outbox cleanup job (real PostgreSQL)', () => {
  let db: TempDatabase;
  let source: DataSource;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;

  const tx = (via: DataSource = source) =>
    new TransactionService(via, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
  const config = (retentionDays = 7, processedEventsRetentionDays = 7) =>
    ({ outbox: { retentionDays, processedEventsRetentionDays } }) as never;
  const cleaner = (days = 7, processedDays = 7, via: DataSource = source) =>
    new OutboxCleanupService(tx(via), config(days, processedDays));

  /** `n` outbox rows, published `ago` ago (an interval) or not published when `ago` is null. */
  async function outbox(n: number, ago: string | null, createdAgo = '0 minutes') {
    await q(
      `INSERT INTO outbox_events(event_id,event_type,aggregate_id,payload,correlation_id,created_at,published_at)
       SELECT gen_random_uuid(),'TransferCompleted',gen_random_uuid(),'{}'::jsonb,gen_random_uuid(),
              now() - $2::interval, CASE WHEN $3::text IS NULL THEN NULL ELSE now() - $3::interval END
       FROM generate_series(1,$1)`,
      [n, createdAgo, ago],
    );
  }
  async function processed(n: number, ago: string) {
    await q(
      `INSERT INTO processed_events(consumer,event_id,processed_at)
       SELECT 'notification', gen_random_uuid(), now() - $2::interval FROM generate_series(1,$1)`,
      [n, ago],
    );
  }
  const count = async (table: 'outbox_events' | 'processed_events') =>
    ((await q(`SELECT count(*)::int AS n FROM ${table}`))[0] as { n: number }).n;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({
      type: 'postgres',
      url: db.url,
      extra: { application_name: 'dbs92-cleanup' },
    }).initialize();
  });
  afterAll(async () => {
    await source?.destroy();
    await db?.drop();
  });
  beforeEach(async () => {
    await q('DELETE FROM outbox_events');
    await q('DELETE FROM processed_events');
  });

  it('TC-92-01 deletes only published rows past the window and never an unpublished one', async () => {
    await outbox(1, '7 days 1 minute');
    await outbox(1, '6 days 23 hours 59 minutes');
    await outbox(1, '0 minutes');
    await outbox(1, null, '400 days'); // unpublished and a year old
    expect(await cleaner().cleanOnce({ pauseMs: 0 })).toMatchObject({ outbox: 1 });
    const left = await q(
      `SELECT published_at IS NULL AS unpublished,
              extract(epoch FROM (now() - COALESCE(published_at, created_at)))::int AS age
       FROM outbox_events ORDER BY age`,
    );
    expect(left).toHaveLength(3);
    expect(left.filter(r => r.unpublished)).toHaveLength(1);
    expect(left.every(r => (r.age as number) < 7 * 86400 || r.unpublished)).toBe(true);
  });

  it('TC-92-02 works in batches, within a budget per table, and finishes on the next run', async () => {
    await outbox(25, '8 days');
    expect(await cleaner().cleanOnce({ batchSize: 10, pauseMs: 0 })).toMatchObject({
      outbox: 25,
    });
    expect(await count('outbox_events')).toBe(0);

    await outbox(25, '8 days');
    const first = await cleaner().cleanOnce({ batchSize: 10, maxBatches: 2, pauseMs: 0 });
    expect(first).toMatchObject({ outbox: 20, truncated: true });
    expect(await count('outbox_events')).toBe(5);
    const second = await cleaner().cleanOnce({ batchSize: 10, maxBatches: 2, pauseMs: 0 });
    expect(second.outbox).toBe(5);
    expect(second.truncated).toBeUndefined();

    // A table's budget is its own: a long outbox backlog does not starve processed_events.
    await outbox(25, '8 days');
    await processed(25, '8 days');
    const both = await cleaner().cleanOnce({ batchSize: 10, maxBatches: 1, pauseMs: 0 });
    expect(both).toMatchObject({ outbox: 10, processed: 10, truncated: true });
  });

  it('TC-92-03 skips a row someone else holds instead of waiting, and takes it next time', async () => {
    await outbox(30, '9 days');
    const [held] = await q('SELECT id FROM outbox_events ORDER BY id LIMIT 1');
    // Its own connection with another name, so it is not mistaken for the job's sessions.
    const lockSource = await new DataSource({
      type: 'postgres',
      url: db.url,
      extra: { application_name: 'dbs92-locker' },
    }).initialize();
    const locker = lockSource.createQueryRunner();
    await locker.startTransaction();
    try {
      await locker.query('SELECT 1 FROM outbox_events WHERE id = $1 FOR UPDATE', [held.id]);
      const states: string[] = [];
      const started = Date.now();
      const result = await cleaner().cleanOnce({
        batchSize: 10,
        pauseMs: 0,
        // Between two batches the job has no transaction open: no lock is held while it rests.
        afterBatch: async () => {
          const sessions = await q(
            `SELECT state FROM pg_stat_activity WHERE application_name = 'dbs92-cleanup'
               AND pid <> pg_backend_pid()`,
          );
          states.push(...sessions.map(s => String(s.state)));
        },
      });
      expect(result.outbox).toBe(29);
      expect(Date.now() - started).toBeLessThan(1500); // it did not wait for the 2 s lock_timeout
      expect(states).not.toContain('idle in transaction');
      expect(await count('outbox_events')).toBe(1);
    } finally {
      await locker.rollbackTransaction();
      await locker.release();
      await lockSource.destroy();
    }
    expect((await cleaner().cleanOnce({ pauseMs: 0 })).outbox).toBe(1);
  });

  it('TC-92-04 both batch statements use their cleanup index, not a sequential scan', async () => {
    await q(
      `INSERT INTO outbox_events(event_id,event_type,aggregate_id,payload,correlation_id,published_at)
       SELECT gen_random_uuid(),'TransferCompleted',gen_random_uuid(),'{}'::jsonb,gen_random_uuid(),
              now() - (g || ' minutes')::interval FROM generate_series(1,30000) g`,
    );
    await q(
      `INSERT INTO processed_events(consumer,event_id,processed_at)
       SELECT 'notification', gen_random_uuid(), now() - (g || ' minutes')::interval
       FROM generate_series(1,30000) g`,
    );
    await q('ANALYZE outbox_events');
    await q('ANALYZE processed_events');
    const nodes = (plan: unknown): Record<string, unknown>[] => {
      const found: Record<string, unknown>[] = [];
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') {
          found.push(value as Record<string, unknown>);
          Object.values(value).forEach(walk);
        }
      };
      walk(plan);
      return found;
    };
    for (const [sql, table, index] of [
      [OUTBOX_BATCH_SQL, 'outbox_events', 'outbox_published_cleanup_idx'],
      [PROCESSED_BATCH_SQL, 'processed_events', 'processed_events_processed_at_idx'],
    ] as const) {
      const [row] = await q(`EXPLAIN (FORMAT JSON) ${sql}`, [7, 1000]);
      const all = nodes(row['QUERY PLAN']);
      expect(all.some(n => n['Index Name'] === index)).toBe(true);
      expect(all.some(n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === table)).toBe(
        false,
      );
    }
  });

  it('TC-92-05 the outbox and the dedup marks follow their own number of days', async () => {
    await outbox(1, '2 days');
    await outbox(1, '20 days');
    await processed(1, '2 days');
    await processed(1, '8 days');
    // One day of outbox does not shorten the dedup marks.
    expect(await cleaner(1, 7).cleanOnce({ pauseMs: 0 })).toMatchObject({
      outbox: 2,
      processed: 1,
    });
    expect(await count('processed_events')).toBe(1);
    await outbox(1, '20 days');
    expect((await cleaner(30, 7).cleanOnce({ pauseMs: 0 })).outbox).toBe(0); // 30 days keeps it
    expect(await count('outbox_events')).toBe(1);
  });

  it('TC-92-08 the worker role runs the job on its own at start-up; the api role does not', async () => {
    const previous = process.env.APP_ROLE;
    try {
      await outbox(4, '9 days');
      await outbox(2, null);
      const worker = cleaner();
      const firstRun = new Promise<unknown>(resolve => (worker.afterRun = resolve));
      process.env.APP_ROLE = 'worker';
      worker.onApplicationBootstrap();
      try {
        await firstRun;
      } finally {
        await worker.onApplicationShutdown();
      }
      expect(await count('outbox_events')).toBe(2); // the unpublished two
      const loop = (w: OutboxCleanupService) =>
        (w as unknown as { loop: { isRunning: boolean } }).loop;
      expect(loop(worker).isRunning).toBe(false);

      const api = cleaner();
      process.env.APP_ROLE = 'api';
      api.onApplicationBootstrap();
      expect(loop(api).isRunning).toBe(false);
      await api.onApplicationShutdown();
    } finally {
      if (previous === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previous;
    }
  });

  it('TC-92-09 two jobs at once delete every row once and never fail on each other', async () => {
    await outbox(3000, '9 days');
    await processed(3000, '9 days');
    const results = await Promise.all([
      cleaner().cleanOnce({ batchSize: 500, pauseMs: 0 }),
      cleaner().cleanOnce({ batchSize: 500, pauseMs: 0 }),
    ]);
    expect(results.reduce((sum, r) => sum + r.outbox, 0)).toBe(3000);
    expect(await count('outbox_events')).toBe(0);
    // processed_events: one job may find the advisory lock taken and leave the table to the other.
    const done = results.reduce((sum, r) => sum + r.processed, 0);
    expect(done).toBeGreaterThan(0);
    expect(done + (await count('processed_events'))).toBe(3000);
    for (let i = 0; i < 3 && (await count('processed_events')) > 0; i++) {
      await cleaner().cleanOnce({ batchSize: 500, pauseMs: 0 });
    }
    expect(await count('processed_events')).toBe(0);
  });

  it('TC-92-10 on shutdown the job stops between two batches', async () => {
    await outbox(25, '9 days');
    const job = cleaner();
    const result = await job.cleanOnce({
      batchSize: 10,
      pauseMs: 0,
      afterBatch: () => job.onApplicationShutdown(),
    });
    expect(result).toMatchObject({ outbox: 10, truncated: true });
    expect(await count('outbox_events')).toBe(15);
  });

  it('TC-92-11 an error between batches keeps the batches already deleted', async () => {
    await outbox(25, '9 days');
    let calls = 0;
    const real = tx();
    const failing = {
      run: (...args: Parameters<TransactionService['run']>) => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error('connection lost'));
        return real.run(...args);
      },
    } as unknown as TransactionService;
    await expect(
      new OutboxCleanupService(failing, config()).cleanOnce({ batchSize: 10, pauseMs: 0 }),
    ).rejects.toThrow('connection lost');
    expect(await count('outbox_events')).toBe(15);
    expect((await cleaner().cleanOnce({ batchSize: 10, pauseMs: 0 })).outbox).toBe(15);
  });

  it('counts through a TypeORM DELETE: the helper reads rows, not the [rows, rowCount] tuple', async () => {
    await outbox(3, '9 days');
    const result = await cleaner().cleanOnce({ batchSize: 100, pauseMs: 0 });
    expect(result.outbox).toBe(3);
  });
});
