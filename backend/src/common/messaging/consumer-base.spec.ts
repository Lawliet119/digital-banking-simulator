import { Logger } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { EntityManager } from 'typeorm';
import type { TransactionService } from '@database/transaction.service';
import type { DomainEvent } from '@common/events';
import { PoisonMessageError, type SqsClient, type SqsMessage } from '@libs/sqs';
import { TRANSFER_SAMPLE } from '../../../test/support/event-samples';
import { ConsumerBase, MAX_ATTEMPTS, dlqUrlFor, type UnknownEventPolicy } from './consumer-base';

class TestConsumer extends ConsumerBase {
  protected readonly consumerName = 'unit';
  readonly applied: DomainEvent[] = [];
  readonly committed: DomainEvent[] = [];
  seenCorrelationId: unknown = 'not-run';
  failure: Error | undefined;
  backoff = 5;
  policy: UnknownEventPolicy = 'dead-letter';

  constructor(
    tx: TransactionService,
    sqs: SqsClient,
    pino: PinoLogger,
    private readonly url: string | null = 'http://localhost:9324/000000000000/unit-events',
  ) {
    super(tx, sqs, pino);
  }
  protected override get retryBackoffSeconds(): number {
    return this.backoff;
  }
  protected override get unknownEventPolicy(): UnknownEventPolicy {
    return this.policy;
  }
  protected queueUrl(): string | undefined {
    return this.url ?? undefined;
  }
  protected apply(event: DomainEvent): Promise<void> {
    this.seenCorrelationId = this.pino.logger.bindings().correlationId;
    if (this.failure) return Promise.reject(this.failure);
    this.applied.push(event);
    return Promise.resolve();
  }
  protected override onCommitted(event: DomainEvent): void {
    this.committed.push(event);
  }
}

describe('DBS-101 ConsumerBase (unit)', () => {
  const seen = new Set<string>();
  const run = jest.fn(async <T>(fn: (manager: EntityManager) => Promise<T>) => {
    const claimed: string[] = [];
    try {
      return await fn({
        query: (_sql: string, args: string[]) => {
          const key = `${args[0]}:${args[1]}`;
          if (seen.has(key)) return Promise.resolve([]);
          seen.add(key);
          claimed.push(key);
          return Promise.resolve([{ event_id: args[1] }]);
        },
      } as unknown as EntityManager);
    } catch (error) {
      for (const key of claimed) seen.delete(key); // a rollback takes the claim back
      throw error;
    }
  });
  const tx = { run } as unknown as TransactionService;
  const processBatch = jest.fn();
  const changeVisibility = jest.fn();
  const sqs = { processBatch, changeVisibility } as unknown as SqsClient;
  const pino = new PinoLogger({ pinoHttp: { level: 'silent' } } as never);
  const message = (receiveCount: number): SqsMessage => ({
    MessageId: 'm-1',
    Attributes: { ApproximateReceiveCount: String(receiveCount) },
  });
  const oldRole = process.env.APP_ROLE;
  let consumer: TestConsumer;

  beforeEach(() => {
    seen.clear();
    run.mockClear();
    processBatch.mockReset();
    changeVisibility.mockReset();
    changeVisibility.mockResolvedValue(undefined);
    consumer = new TestConsumer(tx, sqs, pino);
  });
  afterEach(() => {
    if (oldRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = oldRole;
  });

  it('TC-101-01 applies a new event once and reports it after the commit', async () => {
    await consumer.handle(TRANSFER_SAMPLE, message(1));
    await consumer.handle(TRANSFER_SAMPLE, message(1));
    expect(consumer.applied).toHaveLength(1);
    expect(consumer.committed).toHaveLength(1);
  });

  it('TC-101-04 a body that breaks the schema is poison, and no transaction is opened', async () => {
    for (const body of [
      { eventType: 'TransferCompleted' },
      { ...TRANSFER_SAMPLE, amount: 500000 },
      'a string',
      null,
      { ...TRANSFER_SAMPLE, eventType: 'SomethingNew' },
    ]) {
      await expect(consumer.handle(body, message(1))).rejects.toBeInstanceOf(PoisonMessageError);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('TC-101-05 an unknown event type is acknowledged only when the consumer says so (BL-010)', async () => {
    const unknown = { ...TRANSFER_SAMPLE, eventType: 'SomethingNew' };
    await expect(consumer.handle(unknown, message(1))).rejects.toBeInstanceOf(PoisonMessageError);
    consumer.policy = 'acknowledge';
    await expect(consumer.handle(unknown, message(1))).resolves.toBeUndefined();
    await expect(
      consumer.handle({ ...TRANSFER_SAMPLE, amount: 5 }, message(1)),
    ).rejects.toBeInstanceOf(PoisonMessageError);
    expect(run).not.toHaveBeenCalled();
    expect(consumer.applied).toHaveLength(0);
  });

  it('TC-101-06 a transient error is rethrown until the last attempt, then the message is poison', async () => {
    consumer.failure = new Error('database unavailable');
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await expect(consumer.handle(TRANSFER_SAMPLE, message(attempt))).rejects.toThrow(
        'database unavailable',
      );
    }
    const last = consumer.handle(TRANSFER_SAMPLE, message(MAX_ATTEMPTS));
    await expect(last).rejects.toBeInstanceOf(PoisonMessageError);
    await expect(last).rejects.toMatchObject({ cause: consumer.failure });
  });

  it('TC-101-06 a message without a receive count is treated as a first attempt', async () => {
    consumer.failure = new Error('database unavailable');
    await expect(consumer.handle(TRANSFER_SAMPLE, { MessageId: 'x' })).rejects.toThrow(
      'database unavailable',
    );
  });

  it('TC-101-10 polls only where workers run', () => {
    const start = jest.spyOn((consumer as unknown as { loop: { start(): void } }).loop, 'start');
    process.env.APP_ROLE = 'api';
    consumer.onApplicationBootstrap();
    expect(start).not.toHaveBeenCalled();
    process.env.APP_ROLE = 'worker';
    start.mockImplementation(() => undefined);
    consumer.onApplicationBootstrap();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('TC-101-11 the event correlationId is in the logging context during apply only', async () => {
    await consumer.handle(TRANSFER_SAMPLE, message(1));
    expect(consumer.seenCorrelationId).toBe(TRANSFER_SAMPLE.correlationId);
    expect(pino.logger.bindings().correlationId).toBeUndefined();
  });

  it('TC-134-10 an outer context with another id never leaks into apply, and is restored after', async () => {
    const outer = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    let after: unknown;
    await pino.runInContext(
      async () => {
        await consumer.handle(TRANSFER_SAMPLE, message(1));
        after = pino.logger.bindings().correlationId;
      },
      { bindings: { correlationId: outer } },
    );
    expect(consumer.seenCorrelationId).toBe(TRANSFER_SAMPLE.correlationId);
    expect(after).toBe(outer);
  });

  it('TC-134-09 the backoff warning of a failed event carries that event correlationId', async () => {
    const seenIds: unknown[] = [];
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      seenIds.push(pino.logger.bindings().correlationId);
    });
    try {
      consumer.failure = new Error('database unavailable');
      changeVisibility.mockRejectedValue(new Error('queue refused'));
      await expect(consumer.handle(TRANSFER_SAMPLE, message(1))).rejects.toThrow(
        'database unavailable',
      );
      expect(seenIds).toEqual([TRANSFER_SAMPLE.correlationId]);
    } finally {
      warn.mockRestore();
    }
  });

  it('consumeOnce hands the queue and its dead-letter queue to processBatch', async () => {
    processBatch.mockResolvedValue([]);
    await consumer.consumeOnce(1);
    expect(processBatch).toHaveBeenCalledWith(
      'http://localhost:9324/000000000000/unit-events',
      'http://localhost:9324/000000000000/unit-events-dlq',
      expect.any(Function),
      { waitTimeSeconds: 1 },
    );
    expect(dlqUrlFor('q')).toBe('q-dlq');
  });

  it('consumeOnce fails loudly when the queue is not configured', () => {
    const unconfigured = new TestConsumer(tx, sqs, pino, null);
    expect(() => unconfigured.consumeOnce(1)).toThrow('queue is not configured');
  });
  it('TC-102-03 a transient error hides the message for a doubling backoff before the next receive', async () => {
    consumer.failure = new Error('database unavailable');
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await expect(consumer.handle(TRANSFER_SAMPLE, message(attempt))).rejects.toThrow(
        'database unavailable',
      );
    }
    expect(changeVisibility.mock.calls.map((call: unknown[]) => call[2] as number)).toEqual([
      5, 10, 20, 40,
    ]);
    expect(changeVisibility.mock.calls[0][0]).toBe(
      'http://localhost:9324/000000000000/unit-events',
    );
  });

  it('TC-102-03 the backoff is capped, skipped for poison and for the last attempt, and never hides the real error', async () => {
    consumer.backoff = 100;
    consumer.failure = new Error('database unavailable');
    await expect(consumer.handle(TRANSFER_SAMPLE, message(4))).rejects.toThrow(
      'database unavailable',
    );
    expect(changeVisibility.mock.calls[0][2]).toBe(300);
    changeVisibility.mockClear();
    await expect(consumer.handle(TRANSFER_SAMPLE, message(MAX_ATTEMPTS))).rejects.toBeInstanceOf(
      PoisonMessageError,
    );
    await expect(consumer.handle({ nope: true }, message(1))).rejects.toBeInstanceOf(
      PoisonMessageError,
    );
    consumer.backoff = 0;
    await expect(consumer.handle(TRANSFER_SAMPLE, message(1))).rejects.toThrow(
      'database unavailable',
    );
    expect(changeVisibility).not.toHaveBeenCalled();
    consumer.backoff = 5;
    changeVisibility.mockRejectedValue(new Error('sqs down'));
    await expect(consumer.handle(TRANSFER_SAMPLE, message(1))).rejects.toThrow(
      'database unavailable',
    );
  });
});
