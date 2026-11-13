import {
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { EntityManager } from 'typeorm';
import { runsWorkers } from '@common/app-role/app-role';
import { validateEvent, type DomainEvent } from '@common/events';
import { safeErrorMetadata } from '@common/logging/logging.options';
import { PollingLoop } from '@common/utils/polling-loop';
import { TransactionService } from '@database/transaction.service';
import { PoisonMessageError, SqsClient, type BatchResult, type SqsMessage } from '@libs/sqs';

/** Receives a message may get before it is dead-lettered: 4 retries after the first (ADR-03). */
export const MAX_ATTEMPTS = 5;
const LONG_POLL_SECONDS = 20;
/** The backoff before a retry never exceeds this (the visibility timeout the queue starts from is 30 s). */
const MAX_BACKOFF_SECONDS = 300;

/** `notification-events` -> `notification-events-dlq` (docs/03 §10: each queue has its own DLQ). */
export function dlqUrlFor(queueUrl: string): string {
  return `${queueUrl}-dlq`;
}

/**
 * What a consumer does with an event type it has not heard of (BL-010). During a rolling deploy
 * (ADR-13) an old worker can receive a type a new producer added: `dead-letter` keeps the message
 * for replay, `acknowledge` drops it. Every other schema fault is always dead-lettered.
 */
export type UnknownEventPolicy = 'dead-letter' | 'acknowledge';

function receiveCountOf(message: SqsMessage | undefined): number {
  const count = Number(message?.Attributes?.ApproximateReceiveCount);
  return Number.isInteger(count) && count >= 1 ? count : 1;
}

/**
 * The frame every queue consumer shares (DBS-101). A subclass names itself and its queue and says
 * what to do with one event (`apply`); the frame guarantees the effect happens once:
 *
 * - **One transaction.** `processed_events(consumer, event_id)` is claimed and `apply` runs in the
 *   same transaction, so a crash leaves neither or both. A redelivered event finds the claim and
 *   is acknowledged without a second effect. An error rolls the claim back, so the retry starts
 *   clean.
 * - **Poison goes to the DLQ at the first receive.** A body that breaks the event schema never
 *   gets better, so it is not retried. A transient failure is retried by redelivery, and on the
 *   {@link MAX_ATTEMPTS}-th receive the message is dead-lettered here, so the limit holds even if
 *   the queue has no redrive policy.
 * - **Isolation.** One queue and one DLQ per consumer; a failing consumer only loops on its own
 *   queue (the loop reports the error and waits), and never touches another consumer's messages.
 * - **Workers only.** Polling starts only when `runsWorkers()`; an `api` instance never polls.
 * - **Correlation.** The event's `correlationId` is bound in the logging context (AsyncLocalStorage)
 *   around `apply`, so logs and `OutboxWriter` inside see it.
 *
 * `apply` must not call SQS, Redis or any slow service: it holds the transaction open. Work of that
 * kind goes in `prepare` (DBS-111), which runs before the transaction and hands its result to
 * `apply` and `onCommitted`. The result travels as an argument because a batch is handled
 * concurrently: an instance field would mix up two messages.
 */
export abstract class ConsumerBase implements OnApplicationBootstrap, BeforeApplicationShutdown {
  /** `processed_events.consumer`: stable, one per consumer. */
  protected abstract readonly consumerName: string;
  private readonly baseLogger = new Logger(ConsumerBase.name);
  private readonly loop = new PollingLoop(
    async () => {
      await this.consumeOnce();
      return 0;
    },
    error =>
      this.baseLogger.error(safeErrorMetadata(error), `${this.consumerName} consumer failed`),
  );

  protected constructor(
    protected readonly tx: TransactionService,
    protected readonly sqs: SqsClient,
    protected readonly pino: PinoLogger,
  ) {}

  /** URL of this consumer's queue; `undefined` when the environment does not configure it. */
  protected abstract queueUrl(): string | undefined;

  /**
   * Reads that must not run inside the transaction (Redis, slow queries), before it opens. Throwing
   * here is the same as throwing in `apply`: nothing is written and the message is retried, or
   * dead-lettered for a `PoisonMessageError`. Runs again on every redelivery.
   */
  protected prepare(_event: DomainEvent): Promise<unknown> {
    return Promise.resolve(undefined);
  }

  /** The business effect of one event, inside the transaction that claimed it. */
  protected abstract apply(
    event: DomainEvent,
    manager: EntityManager,
    prepared?: unknown,
  ): Promise<void>;

  /** Runs after the commit, only for the delivery that applied the event (never for a duplicate). */
  protected onCommitted(_event: DomainEvent, _prepared?: unknown): void {
    // Nothing by default.
  }

  /**
   * Seconds the first failed message stays hidden before it is delivered again; each further
   * failure doubles it, up to 300 s. 0 turns the backoff off (the queue's own visibility
   * timeout applies). A consumer of a slow dependency raises it, a test sets 0.
   */
  protected get retryBackoffSeconds(): number {
    return 5;
  }

  protected get unknownEventPolicy(): UnknownEventPolicy {
    return 'dead-letter';
  }

  onApplicationBootstrap(): void {
    if (runsWorkers()) this.loop.start();
  }

  /**
   * Stops the loop and waits for the batch in flight (receive, handlers, deletes) before
   * `SqsClient` destroys its SDK client in `onApplicationShutdown` (BL-249).
   */
  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /** One receive and handle of a batch; failed messages stay on the queue. */
  consumeOnce(
    waitTimeSeconds = LONG_POLL_SECONDS,
    visibilityTimeout?: number,
  ): Promise<BatchResult[]> {
    const queue = this.queueUrl();
    if (!queue) throw new Error(`${this.consumerName} queue is not configured`);
    return this.sqs.processBatch(
      queue,
      dlqUrlFor(queue),
      (body, message) => this.handle(body, message),
      { waitTimeSeconds, ...(visibilityTimeout === undefined ? {} : { visibilityTimeout }) },
    );
  }

  /**
   * Throws `PoisonMessageError` when the message must go to the DLQ now; any other error means
   * "try again". Resolves when the event was applied or had already been applied.
   */
  async handle(body: unknown, message?: SqsMessage): Promise<void> {
    const checked = validateEvent(body);
    if (!checked.ok) {
      const unknownType = checked.issues.some(issue => issue.code === 'UNKNOWN_EVENT_TYPE');
      if (unknownType && this.unknownEventPolicy === 'acknowledge') return;
      throw new PoisonMessageError(
        unknownType ? 'Unknown event type on the queue' : 'Invalid event on the queue',
      );
    }
    const event = checked.event;
    // The whole attempt, failure handling included, runs in the event's context, so the logs of a
    // failed attempt (backoff, DLQ decision) carry its correlationId too.
    await this.pino.runInContext(
      async () => {
        try {
          await this.process(event);
        } catch (error) {
          if (error instanceof PoisonMessageError) throw error;
          const attempt = receiveCountOf(message);
          if (attempt >= MAX_ATTEMPTS) {
            throw new PoisonMessageError('Event kept failing and used up its attempts', {
              cause: error,
            });
          }
          await this.backOff(message, attempt);
          throw error;
        }
      },
      { bindings: { role: 'worker', correlationId: event.correlationId } },
    );
  }

  /** Never hides the real error: if the queue refuses the new timeout, the default one applies. */
  private async backOff(message: SqsMessage | undefined, attempt: number): Promise<void> {
    const queue = this.queueUrl();
    const base = this.retryBackoffSeconds;
    if (!message || !queue || base <= 0) return;
    const seconds = Math.min(base * 2 ** (attempt - 1), MAX_BACKOFF_SECONDS);
    try {
      await this.sqs.changeVisibility(queue, message, seconds);
    } catch (error) {
      this.baseLogger.warn(safeErrorMetadata(error), `${this.consumerName} backoff not applied`);
    }
  }

  private async process(event: DomainEvent): Promise<void> {
    const prepared = await this.prepare(event);
    const first = await this.tx.run(async manager => {
      const claimed: unknown[] = await manager.query(
        `INSERT INTO processed_events(consumer,event_id) VALUES($1,$2)
         ON CONFLICT(consumer,event_id) DO NOTHING RETURNING event_id`,
        [this.consumerName, event.eventId],
      );
      if (claimed.length === 0) return false;
      await this.apply(event, manager, prepared);
      return true;
    });
    if (first) this.onCommitted(event, prepared);
  }
}
