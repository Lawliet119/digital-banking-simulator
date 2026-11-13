import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TransactionService } from '@database/transaction.service';
import { MetricsService } from '@common/metrics';
import {
  CLEANUP_ERROR_DELAY_MS,
  CLEANUP_EVERY_MS,
  IDEMPOTENCY_BATCH_SQL,
  OUTBOX_BATCH_SQL,
  OutboxCleanupService,
  PROCESSED_BATCH_SQL,
} from './outbox-cleanup.service';
import { OutboxRelayModule } from './outbox-relay.module';

@Global()
@Module({
  providers: [{ provide: TransactionService, useValue: {} }],
  exports: [TransactionService],
})
class StubDatabase {}

// OutboxRelayModule registers a gauge with the global MetricsService (DBS-144).
@Global()
@Module({
  providers: [{ provide: MetricsService, useValue: { registerGauge: () => undefined } }],
  exports: [MetricsService],
})
class StubMetrics {}

describe('DBS-92 outbox cleanup wiring', () => {
  const originalEnv = process.env;
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    process.env = originalEnv;
  });

  async function build(extra: Record<string, string>): Promise<OutboxCleanupService> {
    process.env = {
      NODE_ENV: 'test',
      APP_ROLE: 'api',
      DATABASE_URL: 'postgres://localhost:5432/not_opened',
      REDIS_URL: 'redis://localhost:6379',
      SQS_RISK_QUEUE_URL: 'http://localhost:9324/000000000000/risk-events',
      SQS_NOTIFICATION_QUEUE_URL: 'http://localhost:9324/000000000000/notification-events',
      ...extra,
    };
    const { ConfigModule } = await import('../../config/config.module');
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, StubDatabase, StubMetrics, OutboxRelayModule],
    }).compile();
    return moduleRef.get(OutboxCleanupService, { strict: false });
  }

  it('TC-92-07 the service gets the retention days from the environment through DI', async () => {
    const service = await build({
      OUTBOX_RETENTION_DAYS: '30',
      PROCESSED_EVENTS_RETENTION_DAYS: '14',
      IDEMPOTENCY_KEY_RETENTION_DAYS: '30',
    });
    expect(service.retention).toEqual({
      outboxDays: 30,
      processedEventsDays: 14,
      idempotencyDays: 30,
    });
  });

  it('TC-92-07 without the variables it uses 7 and 7', async () => {
    const service = await build({});
    expect(service.retention).toEqual({
      outboxDays: 7,
      processedEventsDays: 7,
      idempotencyDays: 7,
    });
  });

  it('TC-92-12 a failing run is retried after a minute, not every 5 seconds', async () => {
    const service = await build({});
    const loop = (service as unknown as { loop: { errorDelayMs: number } }).loop;
    expect(CLEANUP_ERROR_DELAY_MS).toBeGreaterThanOrEqual(60_000);
    expect(loop.errorDelayMs).toBe(CLEANUP_ERROR_DELAY_MS);
    expect(CLEANUP_EVERY_MS).toBe(3_600_000);
  });
});

describe('BL-219 a failing table does not stop the others', () => {
  const limits = {
    idempotencyKeyRetentionDays: 7,
    outbox: { retentionDays: 7, processedEventsRetentionDays: 7 },
  } as never;

  type Manager = { query: (sql: string) => Promise<unknown[]> };

  /** A fake transaction: `answer(sql)` replies to each batch statement; the SQL text names the table. */
  function build(answer: (sql: string) => { count: number } | Error) {
    const statements: string[] = [];
    const tx = {
      run: (work: (manager: Manager) => Promise<unknown>) =>
        work({
          query: (sql: string) => {
            if (sql.includes('pg_try_advisory_xact_lock'))
              return Promise.resolve([{ locked: true }]);
            statements.push(sql);
            const reply = answer(sql);
            return reply instanceof Error ? Promise.reject(reply) : Promise.resolve([reply]);
          },
        }),
    };
    const service = new OutboxCleanupService(tx as never, limits);
    const logged: { level: string; table?: unknown }[] = [];
    const logger = (service as unknown as { logger: Record<string, unknown> }).logger;
    for (const level of ['error', 'warn', 'log']) {
      logger[level] = (meta: { table?: unknown }) => logged.push({ level, table: meta?.table });
    }
    return { service, statements, logged };
  }

  const refused = Object.assign(new Error('permission denied for table outbox_events'), {
    code: '42501',
  });

  it('the first table always fails: processed and idempotency are still cleaned, the round throws', async () => {
    const { service, statements, logged } = build(sql =>
      sql === OUTBOX_BATCH_SQL ? refused : { count: 2 },
    );

    await expect(service.cleanOnce({ batchSize: 10, pauseMs: 0 })).rejects.toBe(refused);

    expect(statements).toEqual([OUTBOX_BATCH_SQL, PROCESSED_BATCH_SQL, IDEMPOTENCY_BATCH_SQL]);
    expect(logged).toContainEqual({ level: 'error', table: 'outbox' });
  });

  it('two tables fail: the third is cleaned and the round throws an AggregateError naming both', async () => {
    const { service, statements } = build(sql => {
      if (sql === OUTBOX_BATCH_SQL) return refused;
      if (sql === PROCESSED_BATCH_SQL) return new Error('timeout');
      return { count: 1 };
    });

    const failure: unknown = await service
      .cleanOnce({ batchSize: 10, pauseMs: 0 })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([refused, new Error('timeout')]);
    expect((failure as AggregateError).message).toBe('Outbox cleanup failed for outbox, processed');
    expect(statements).toEqual([OUTBOX_BATCH_SQL, PROCESSED_BATCH_SQL, IDEMPOTENCY_BATCH_SQL]);
  });

  it('no failure: the result is unchanged', async () => {
    const { service } = build(() => ({ count: 3 }));
    await expect(service.cleanOnce({ batchSize: 10, pauseMs: 0 })).resolves.toEqual({
      outbox: 3,
      processed: 3,
      idempotency: 3,
      batches: 3,
    });
  });

  it('the loop passes the failed round to afterRun, so its error log and 60 s backoff still apply', async () => {
    const originalRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'worker';
    const { service } = build(sql => (sql === OUTBOX_BATCH_SQL ? refused : { count: 0 }));
    const outcome = new Promise<unknown>(resolve => (service.afterRun = resolve));
    try {
      service.onApplicationBootstrap();
      expect(await outcome).toBe(refused);
    } finally {
      await service.onApplicationShutdown();
      if (originalRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = originalRole;
    }
  });
});
