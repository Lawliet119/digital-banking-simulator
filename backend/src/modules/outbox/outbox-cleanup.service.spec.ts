import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TransactionService } from '@database/transaction.service';
import {
  CLEANUP_ERROR_DELAY_MS,
  CLEANUP_EVERY_MS,
  OutboxCleanupService,
} from './outbox-cleanup.service';
import { OutboxRelayModule } from './outbox-relay.module';

@Global()
@Module({
  providers: [{ provide: TransactionService, useValue: {} }],
  exports: [TransactionService],
})
class StubDatabase {}

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
      imports: [ConfigModule, StubDatabase, OutboxRelayModule],
    }).compile();
    return moduleRef.get(OutboxCleanupService, { strict: false });
  }

  it('TC-92-07 the service gets the retention days from the environment through DI', async () => {
    const service = await build({
      OUTBOX_RETENTION_DAYS: '30',
      PROCESSED_EVENTS_RETENTION_DAYS: '14',
    });
    expect(service.retention).toEqual({ outboxDays: 30, processedEventsDays: 14 });
  });

  it('TC-92-07 without the variables it uses 7 and 7', async () => {
    const service = await build({});
    expect(service.retention).toEqual({ outboxDays: 7, processedEventsDays: 7 });
  });

  it('TC-92-12 a failing run is retried after a minute, not every 5 seconds', async () => {
    const service = await build({});
    const loop = (service as unknown as { loop: { errorDelayMs: number } }).loop;
    expect(CLEANUP_ERROR_DELAY_MS).toBeGreaterThanOrEqual(60_000);
    expect(loop.errorDelayMs).toBe(CLEANUP_ERROR_DELAY_MS);
    expect(CLEANUP_EVERY_MS).toBe(3_600_000);
  });
});
