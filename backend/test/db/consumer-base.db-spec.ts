import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { DataSource, type EntityManager } from 'typeorm';
import { ConsumerBase } from '@common/messaging';
import type { DomainEvent } from '@common/events';
import { TransactionService } from '@database/transaction.service';
import { OutboxWriter } from '@modules/outbox';
import type { SqsClient } from '@libs/sqs';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/** A consumer whose effect is one `notification_log` row, so "one effect" is a row count. */
class LogConsumer extends ConsumerBase {
  protected readonly consumerName = 'dbs101';
  failures = 0;
  constructor(tx: TransactionService) {
    super(tx, {} as SqsClient, new PinoLogger({ pinoHttp: { level: 'silent' } } as never));
  }
  protected queueUrl(): string {
    return 'http://localhost:9324/000000000000/dbs101';
  }
  protected async apply(event: DomainEvent, manager: EntityManager): Promise<void> {
    await manager.query(
      `INSERT INTO notification_log(event_id,kind,user_id,message) VALUES($1,'transfer_completed',NULL,'x')`,
      [event.eventId],
    );
    if (this.failures > 0) {
      this.failures--;
      throw new Error('boom after the effect');
    }
  }
}

/** DBS-134: a consumer whose effect is a new outbox event, written by the real OutboxWriter. */
class WritingConsumer extends ConsumerBase {
  protected readonly consumerName = 'dbs134';
  private readonly writer: OutboxWriter;
  constructor(tx: TransactionService, pino: PinoLogger) {
    super(tx, {} as SqsClient, pino);
    this.writer = new OutboxWriter(pino);
  }
  protected queueUrl(): string {
    return 'http://localhost:9324/000000000000/dbs134';
  }
  protected async apply(event: DomainEvent, manager: EntityManager): Promise<void> {
    await this.writer.add(manager, { ...event, eventId: randomUUID() });
  }
}

/** DBS-101: the idempotent frame against real PostgreSQL. */
describe('ConsumerBase (real PostgreSQL)', () => {
  let db: TempDatabase;
  let source: DataSource;
  let consumer: LogConsumer;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;
  const rows = async (eventId: string) => ({
    processed: (
      (
        await q(
          `SELECT count(*)::int n FROM processed_events WHERE consumer='dbs101' AND event_id=$1`,
          [eventId],
        )
      )[0] as { n: number }
    ).n,
    effects: (
      (await q(`SELECT count(*)::int n FROM notification_log WHERE event_id=$1`, [eventId]))[0] as {
        n: number;
      }
    ).n,
  });
  const event = () => ({ ...TRANSFER_SAMPLE, eventId: randomUUID() });

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    consumer = new LogConsumer(
      new TransactionService(source, {
        lockTimeoutMs: 2000,
        statementTimeoutMs: 5000,
        idleInTransactionTimeoutMs: 10000,
      } as never),
    );
  });
  afterAll(async () => {
    await source?.destroy();
    await db?.drop();
  });

  it('TC-101-01 the same eventId received three times has one effect', async () => {
    const e = event();
    for (let i = 0; i < 3; i++) await consumer.handle(e);
    expect(await rows(e.eventId)).toEqual({ processed: 1, effects: 1 });
  });

  it('TC-101-02 two deliveries at the same time have one effect', async () => {
    const e = event();
    await Promise.all([consumer.handle(e), consumer.handle(e), consumer.handle(e)]);
    expect(await rows(e.eventId)).toEqual({ processed: 1, effects: 1 });
  });

  it('TC-101-03 an error after the effect rolls back the effect and the claim, so a retry applies once', async () => {
    const e = event();
    consumer.failures = 1;
    await expect(consumer.handle(e)).rejects.toThrow('boom after the effect');
    expect(await rows(e.eventId)).toEqual({ processed: 0, effects: 0 });
    await consumer.handle(e);
    await consumer.handle(e);
    expect(await rows(e.eventId)).toEqual({ processed: 1, effects: 1 });
  });
  it('TC-134-10 the real OutboxWriter accepts the event id inside apply even when the caller context has another id', async () => {
    const pino = new PinoLogger({ pinoHttp: { level: 'silent' } } as never);
    const writing = new WritingConsumer(
      new TransactionService(source, {
        lockTimeoutMs: 2000,
        statementTimeoutMs: 5000,
        idleInTransactionTimeoutMs: 10000,
      } as never),
      pino,
    );
    const e = event();
    await pino.runInContext(() => writing.handle(e), {
      bindings: { correlationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    });
    const written = await q(
      `SELECT correlation_id FROM outbox_events WHERE payload->>'transferId' = $1`,
      [e.transferId],
    );
    expect(written).toEqual([{ correlation_id: e.correlationId }]);
  });
});
