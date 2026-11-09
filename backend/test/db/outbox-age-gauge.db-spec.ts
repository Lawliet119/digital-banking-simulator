import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { MetricsService } from '@common/metrics';
import {
  OUTBOX_AGE_METRIC,
  OUTBOX_AGE_SQL,
  OutboxAgeGauge,
} from '@modules/outbox/outbox-age.gauge';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/** TC-144-07: the age of the oldest unpublished outbox row, on real PostgreSQL. */
describe('OutboxAgeGauge (real PostgreSQL)', () => {
  let db: TempDatabase;
  let source: DataSource;
  let gauge: OutboxAgeGauge;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;

  async function insert(agoSeconds: number, published: boolean): Promise<void> {
    await q(
      `INSERT INTO outbox_events(event_type, aggregate_id, payload, correlation_id, created_at, published_at)
       VALUES ('TransferCompleted', $1, '{}'::jsonb, $2, clock_timestamp() - make_interval(secs => $3),
               CASE WHEN $4 THEN clock_timestamp() END)`,
      [randomUUID(), randomUUID(), agoSeconds, published],
    );
  }

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    gauge = new OutboxAgeGauge(
      new TransactionService(source, {
        lockTimeoutMs: 2000,
        statementTimeoutMs: 5000,
        idleInTransactionTimeoutMs: 10000,
      } as never),
      { registerGauge: jest.fn() } as unknown as MetricsService,
    );
  });
  afterAll(async () => {
    await source?.destroy();
    await db?.drop();
  });
  beforeEach(async () => {
    await q('DELETE FROM outbox_events');
  });

  it('TC-144-07 is 0 when nothing waits', async () => {
    expect(await gauge.read()).toBe(0);
  });

  it('TC-144-07 is the age of a waiting row, by the clock of the database', async () => {
    await insert(42, false);
    const age = await gauge.read();
    expect(age).toBeGreaterThanOrEqual(42);
    expect(age).toBeLessThan(44);
  });

  it('TC-144-07 does not count a row that was published, however old', async () => {
    await insert(3600, true);
    expect(await gauge.read()).toBe(0);
    await insert(5, false);
    const age = await gauge.read();
    expect(age).toBeGreaterThanOrEqual(5);
    expect(age).toBeLessThan(7);
  });

  it('TC-144-07 with several waiting rows it reports the oldest one', async () => {
    await insert(90, false);
    await insert(30, false);
    await insert(10, false);
    const age = await gauge.read();
    expect(age).toBeGreaterThanOrEqual(90);
    expect(age).toBeLessThan(92);
  });

  it('TC-144-07 reads through the partial index of unpublished rows', async () => {
    for (let i = 0; i < 20; i++) await insert(i, false);
    await q('ANALYZE outbox_events');
    await q('BEGIN');
    try {
      await q('SET LOCAL enable_seqscan = off');
      const plan = await q(`EXPLAIN (FORMAT JSON) ${OUTBOX_AGE_SQL}`);
      expect(JSON.stringify(plan)).toContain('outbox_unpublished_idx');
    } finally {
      await q('ROLLBACK');
    }
  });

  it('TC-144-07 registers itself as a gauge of seconds when the process runs workers', () => {
    const registerGauge = jest.fn();
    const registered = new OutboxAgeGauge(
      {} as TransactionService,
      {
        registerGauge,
      } as unknown as MetricsService,
    );
    registered.onModuleInit();
    expect(registerGauge).toHaveBeenCalledTimes(1);
    expect(registerGauge).toHaveBeenCalledWith(
      expect.objectContaining({ name: OUTBOX_AGE_METRIC, unit: 'Seconds' }),
    );
  });
});
