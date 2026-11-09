import { randomUUID } from 'node:crypto';
import { IDEMPOTENCY_BATCH_SQL, PROCESSED_BATCH_SQL } from '@modules/outbox/outbox-cleanup.service';
import { createDedupCleanupFixture, type DedupCleanupFixture } from '../support/dedup-cleanup';

describe('DBS-136 dedup retention on real PostgreSQL and actual worker LOGIN', () => {
  let f: DedupCleanupFixture;
  beforeAll(async () => {
    f = await createDedupCleanupFixture();
  });
  beforeEach(async () => {
    await f.reset();
  });
  afterEach(async () => {
    if (f) await f.invariants();
  });
  afterAll(async () => {
    await f?.close();
  });

  it('TC-136-01 fake clock preserves exact cutoff and newer rows in both tables', async () => {
    await f.seedBoundaries();
    const result = await f.job().cleanOnce({ pauseMs: 0 });
    expect(result).toMatchObject({ idempotency: 1, processed: 1 });
    expect(await f.labels()).toEqual({ keys: ['boundary', 'fresh'], marks: ['boundary', 'fresh'] });
  });

  it('TC-136-02 per-table retention and one frozen cutoff survive clock advancement between batches', async () => {
    await f.seedAge('old', 31);
    await f.seedAge('middle', 20);
    await f.seedAge('fresh', 10);
    const result = await f.job(30, 14).cleanOnce({
      batchSize: 1,
      pauseMs: 0,
      afterBatch: () => {
        f.clock.instant = new Date(f.base.getTime() + 40 * 86400000);
      },
    });
    expect(result).toMatchObject({ idempotency: 1, processed: 2 });
    expect(await f.labels()).toEqual({ keys: ['fresh', 'middle'], marks: ['fresh'] });
  });

  it('TC-136-03 worker uses bounded independent batches and commits before resting', async () => {
    const [role] = await f.worker.query('SELECT current_user,session_user');
    expect(role).toEqual({ current_user: 'dbs_worker', session_user: 'dbs_worker' });
    await f.seedMany(25);
    const result = await f.job().cleanOnce({
      batchSize: 10,
      maxBatches: 2,
      pauseMs: 0,
      afterBatch: async () => {
        const open = await f.owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name='dbs136-worker' AND state='idle in transaction'",
        );
        expect(open).toEqual([]);
      },
    });
    expect(result).toMatchObject({ idempotency: 20, processed: 20, truncated: true });
    expect(await f.counts()).toEqual({ keys: 5, marks: 5 });
    expect(await f.job().cleanOnce({ pauseMs: 0 })).toMatchObject({ idempotency: 5, processed: 5 });
  });

  it('TC-136-04 a locked expired key fails with 55P03, rolls back the batch, then recovers', async () => {
    await f.seedAge('ready', 9);
    await f.seedAge('locked', 8);
    const locker = f.owner.createQueryRunner();
    await locker.startTransaction();
    try {
      await locker.query("SELECT 1 FROM idempotency_keys WHERE idem_key='locked' FOR UPDATE");
      const started = Date.now();
      await expect(f.job().cleanOnce({ pauseMs: 0 })).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeLessThan(3000);
      expect((await f.counts()).keys).toBe(2);
    } finally {
      await locker.rollbackTransaction();
      await locker.release();
    }
    expect((await f.job().cleanOnce({ pauseMs: 0 })).idempotency).toBe(2);
  });

  it('TC-136-05 concurrent workers never double-delete and preserve fresh metadata', async () => {
    await f.seedMany(25);
    await f.seedAge('fresh', 1);
    const results = await Promise.all([
      f.job().cleanOnce({ batchSize: 10, pauseMs: 0 }),
      f.job().cleanOnce({ batchSize: 10, pauseMs: 0 }),
    ]);
    expect(results.reduce((sum, r) => sum + r.idempotency, 0)).toBe(25);
    expect(results.reduce((sum, r) => sum + r.processed, 0)).toBe(25);
    expect(await f.labels()).toEqual({ keys: ['fresh'], marks: ['fresh'] });
  });

  it('TC-136-06 real deposit replays at seven days; after cleanup the same key becomes a new command', async () => {
    const key = randomUUID();
    const first = await f.deposit(key);
    const [{ created_at: created }] = await f.owner.query<{ created_at: Date }[]>(
      'SELECT created_at FROM idempotency_keys WHERE idem_key=$1',
      [key],
    );
    f.clock.instant = new Date(created.getTime() + 7 * 86400000);
    expect((await f.job().cleanOnce({ pauseMs: 0 })).idempotency).toBe(0);
    expect(await f.deposit(key)).toEqual(first);
    await f.invariants();
    f.clock.instant = new Date(f.clock.instant.getTime() + 1);
    expect((await f.job().cleanOnce({ pauseMs: 0 })).idempotency).toBe(1);
    expect((await f.deposit(key)).transferId).not.toBe(first.transferId);
    const [{ balance }] = await f.owner.query('SELECT balance FROM accounts WHERE id=$1', [
      f.accountId,
    ]);
    expect(balance).toBe('2000000');
  });

  it.each([
    [IDEMPOTENCY_BATCH_SQL, 'idempotency_keys', 'idempotency_keys_created_idx'],
    [PROCESSED_BATCH_SQL, 'processed_events', 'processed_events_processed_at_idx'],
  ])(
    'TC-136-07 %s uses %s cleanup index without forcing the planner',
    async (sql, table, index) => {
      await f.seedPlanRows();
      const [plan] = await f.owner.query(`EXPLAIN (FORMAT JSON) ${sql}`, [
        new Date(f.base.getTime() - 7 * 86400000),
        1000,
      ]);
      const nodes: Record<string, unknown>[] = [];
      const walk = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') {
          nodes.push(value as Record<string, unknown>);
          Object.values(value).forEach(walk);
        }
      };
      walk(plan);
      expect(nodes.some(n => n['Index Name'] === index)).toBe(true);
      expect(nodes.some(n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === table)).toBe(
        false,
      );
    },
  );

  it('TC-136-09 role lifecycle stops between batches and a restarted worker drains the remainder', async () => {
    await f.seedMany(25);
    const job = f.job();
    const partial = await job.cleanOnce({
      batchSize: 10,
      pauseMs: 0,
      afterBatch: async () => {
        if ((await f.counts()).marks < 25) await job.onApplicationShutdown();
      },
    });
    expect(partial.truncated).toBe(true);
    expect(await f.counts()).toEqual({ keys: 25, marks: 15 });
    await f.lifecycle('api');
    expect(await f.counts()).toEqual({ keys: 25, marks: 15 });
    await f.lifecycle('worker');
    expect(await f.counts()).toEqual({ keys: 0, marks: 0 });
  });

  it('TC-136-10 retained consumer marker blocks duplicate claim; expired and removed allows claim', async () => {
    await f.seedAge('marker', 7);
    const [{ event_id: eventId }] = await f.owner.query(
      "SELECT event_id FROM processed_events WHERE consumer='marker'",
    );
    const claim = () =>
      f.worker.query(
        "INSERT INTO processed_events(consumer,event_id) VALUES('marker',$1) ON CONFLICT DO NOTHING RETURNING event_id",
        [eventId],
      );
    await f.job().cleanOnce({ pauseMs: 0 });
    expect(await claim()).toEqual([]);
    f.clock.instant = new Date(f.base.getTime() + 1);
    await f.job().cleanOnce({ pauseMs: 0 });
    expect(await claim()).toEqual([{ event_id: eventId }]);
  });
});
