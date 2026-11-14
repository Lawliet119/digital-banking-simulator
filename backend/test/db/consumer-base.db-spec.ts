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
  /** TC-101-02: the next `apply` signals `entered`, then waits for `release` while it holds the claim. */
  private gate?: { entered: () => void; release: Promise<void> };
  constructor(tx: TransactionService) {
    super(tx, {} as SqsClient);
  }
  holdNextApply(gate: { entered: () => void; release: Promise<void> }): void {
    this.gate = gate;
  }
  protected queueUrl(): string {
    return 'http://localhost:9324/000000000000/dbs101';
  }
  protected async apply(event: DomainEvent, manager: EntityManager): Promise<void> {
    await manager.query(
      `INSERT INTO notification_log(event_id,kind,user_id,message) VALUES($1,'transfer_completed',NULL,'x')`,
      [event.eventId],
    );
    const gate = this.gate;
    if (gate) {
      this.gate = undefined; // only the first apply is held; the one that waits behind it is not
      gate.entered();
      await gate.release;
    }
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
  constructor(tx: TransactionService) {
    super(tx, {} as SqsClient);
    this.writer = new OutboxWriter();
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
  /** Same consumer name, but a lock wait of 20 s: the TC-101-02 tests hold a claim on purpose. */
  let patient: LogConsumer;
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
    patient = new LogConsumer(
      new TransactionService(source, {
        lockTimeoutMs: 20000,
        statementTimeoutMs: 20000,
        idleInTransactionTimeoutMs: 20000,
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

  /**
   * Holds the claim of `e` inside the first delivery (its transaction is open, not committed),
   * starts the second delivery, and returns once PostgreSQL itself reports the second INSERT as
   * waiting on a lock held by that first transaction. `release` lets the first delivery go on.
   */
  async function secondDeliveryWaitsForTheClaim(e: { eventId: string }): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await q(
        `SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE 'INSERT INTO processed_events%'`,
      );
      if (waiting.length > 0) {
        const blockers = (waiting[0] as { blockers: number[] }).blockers;
        expect(waiting).toHaveLength(1);
        expect(blockers).toHaveLength(1);
        // The blocker is the first delivery: its transaction is open and idle in the Node process.
        const holder = await q(`SELECT state FROM pg_stat_activity WHERE pid = $1`, [blockers[0]]);
        expect(holder).toEqual([{ state: 'idle in transaction' }]);
        // Nothing of the held transaction is visible to anyone else yet.
        expect(await rows(e.eventId)).toEqual({ processed: 0, effects: 0 });
        return;
      }
      if (Date.now() > deadline) throw new Error('the second delivery never waited for the claim');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  function gate() {
    let entered!: () => void;
    let release!: () => void;
    return {
      inside: new Promise<void>(resolve => (entered = resolve)),
      entered: () => entered(),
      release: new Promise<void>(resolve => (release = resolve)),
      open: () => release(),
    };
  }

  it('TC-101-02 a second delivery of the same event waits behind the open claim (pg_locks), then finds it committed and adds nothing', async () => {
    const e = event();
    const hold = gate();
    patient.holdNextApply(hold);
    const first = patient.handle(e);
    try {
      await hold.inside; // first delivery: claim inserted, effect written, transaction still open
      let secondDone = false;
      const second = patient.handle(e).then(() => {
        secondDone = true;
      });
      await secondDeliveryWaitsForTheClaim(e);
      expect(secondDone).toBe(false);
      hold.open();
      await Promise.all([first, second]);
      expect(secondDone).toBe(true);
      expect(await rows(e.eventId)).toEqual({ processed: 1, effects: 1 });
    } finally {
      hold.open();
      await first.catch(() => undefined);
    }
  });

  it('TC-101-02 when the first delivery rolls back while the second waits, the second applies the event exactly once', async () => {
    const e = event();
    const hold = gate();
    patient.failures = 1; // the held delivery fails after its effect
    patient.holdNextApply(hold);
    const first = patient.handle(e);
    const firstOutcome = first.then(
      () => 'applied',
      (error: Error) => error.message,
    );
    try {
      await hold.inside;
      const second = patient.handle(e);
      await secondDeliveryWaitsForTheClaim(e);
      hold.open();
      expect(await firstOutcome).toBe('boom after the effect');
      await second;
      expect(await rows(e.eventId)).toEqual({ processed: 1, effects: 1 });
    } finally {
      hold.open();
      await firstOutcome;
    }
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
