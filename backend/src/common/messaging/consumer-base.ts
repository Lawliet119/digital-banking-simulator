import {
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { EntityManager } from 'typeorm';
import { runsWorkers } from '@common/app-role/app-role';
import { validateEvent, type DomainEvent } from '@common/events';
import { runInLogContext } from '@common/logging/log-context';
import { safeErrorMetadata } from '@common/logging/logging.options';
import { PollingLoop } from '@common/utils/polling-loop';
import { TransactionService } from '@database/transaction.service';
import { PoisonMessageError, SqsClient, type BatchResult, type SqsMessage } from '@libs/sqs';
import { countConsumerMessage, type ConsumerOutcome } from './consumer.metrics';

/** Receives a message may get before it is dead-lettered: 4 retries after the first (ADR-03). */
export const MAX_ATTEMPTS = 5;
/**
 * First backoff in seconds (BL-210). It doubles per failure: 10, 20, 40, 80 between the five
 * receives, so a message is dead-lettered about 150 s after its first failure. That covers the 120 s
 * ADR-03 assumed and a PostgreSQL Multi-AZ failover (60 to 120 s); 75 s (5, 10, 20, 40) did not.
 */
const DEFAULT_BACKOFF_SECONDS = 10;
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
 * - **Visible failures (BL-209).** Every retry and every dead-letter decision is one log line
 *   (`consumer`, `eventId`, `receiveCount`, `outcome`, the error class and SQLSTATE through
 *   `safeErrorMetadata`; never the body, never the error message) and one increment of
 *   `consumer_message_total{Consumer, Outcome}`.
 * - **Shutdown.** The long poll is cancelled when the application stops, so the loop ends in
 *   moments instead of up to 20 s (ECS gives a worker `stopTimeout` 60 s).
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
  /** Aborts the long poll in flight; made when the loop starts, aborted by `beforeApplicationShutdown`. */
  private pollAbort: AbortController | undefined;
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
   * failure doubles it, up to 300 s. The default 10 gives 10, 20, 40, 80 s (150 s in all, BL-210).
   * 0 turns the backoff off (the queue's own visibility timeout applies). A consumer of a slow
   * dependency raises it, a test sets 0.
   */
  protected get retryBackoffSeconds(): number {
    return DEFAULT_BACKOFF_SECONDS;
  }

  protected get unknownEventPolicy(): UnknownEventPolicy {
    return 'dead-letter';
  }

  onApplicationBootstrap(): void {
    if (!runsWorkers()) return;
    this.pollAbort = new AbortController();
    this.loop.start();
  }

  /**
   * Stops the loop and waits for the batch in flight (handlers, deletes) before `SqsClient`
   * destroys its SDK client in `onApplicationShutdown` (BL-249). A long poll that is still waiting
   * for a message is cancelled first (BL-209), so this returns when the handlers have finished
   * and not after up to 20 s of waiting for a queue that is empty.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.pollAbort?.abort();
    await this.loop.stop();
  }

  /** One receive and handle of a batch; failed messages stay on the queue. */
  consumeOnce(
    waitTimeSeconds = LONG_POLL_SECONDS,
    visibilityTimeout?: number,
  ): Promise<BatchResult[]> {
    const queue = this.queueUrl();
    if (!queue) throw new Error(`${this.consumerName} queue is not configured`);
    const signal = this.pollAbort?.signal;
    if (signal?.aborted) return Promise.resolve([]);
    return Promise.resolve(
      this.sqs.processBatch(
        queue,
        dlqUrlFor(queue),
        (body, message) => this.handle(body, message),
        {
          waitTimeSeconds,
          ...(visibilityTimeout === undefined ? {} : { visibilityTimeout }),
          ...(signal === undefined ? {} : { abortSignal: signal }),
        },
      ),
    ).catch((error: unknown) => {
      // Only the receive can throw out of processBatch. A shutdown that cancelled it is not a
      // failure to report, and the loop is about to end anyway.
      if (signal?.aborted) return [];
      throw error;
    });
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
      // The body is not trusted and is never logged, not even its eventId, which may be anything.
      // The issue codes are a fixed vocabulary; their paths can be keys the sender chose, so they
      // stay out. The SQS message id says which message it was.
      this.observe('dead_letter', {
        receiveCount: receiveCountOf(message),
        ...(message?.MessageId === undefined ? {} : { messageId: message.MessageId }),
        reason: unknownType ? 'unknown_event_type' : 'invalid_event',
        issueCodes: [...new Set(checked.issues.map(issue => issue.code))].sort(),
      });
      throw new PoisonMessageError(
        unknownType ? 'Unknown event type on the queue' : 'Invalid event on the queue',
      );
    }
    const event = checked.event;
    // The whole attempt, failure handling included, runs in the event's context, so the logs of a
    // failed attempt (backoff, DLQ decision) carry its correlationId too.
    await runInLogContext(
      async () => {
        try {
          await this.process(event);
        } catch (error) {
          const attempt = receiveCountOf(message);
          const fields = { eventId: event.eventId, receiveCount: attempt };
          if (error instanceof PoisonMessageError) {
            // The handler decided: the cause (a SQLSTATE such as 23503) says why.
            this.observe('dead_letter', { ...fields, reason: 'poison' }, error.cause ?? error);
            throw error;
          }
          if (attempt >= MAX_ATTEMPTS) {
            this.observe('dead_letter', { ...fields, reason: 'attempts_exhausted' }, error);
            throw new PoisonMessageError('Event kept failing and used up its attempts', {
              cause: error,
            });
          }
          this.observe('retry', fields, error);
          await this.backOff(message, attempt);
          throw error;
        }
      },
      { role: 'worker', correlationId: event.correlationId },
    );
  }

  /**
   * One structured line and one count for a retry or a dead-letter decision (BL-209). `fields`
   * is built by the caller from ids and counts only; the error contributes its class and SQLSTATE
   * through `safeErrorMetadata`, never its message (a driver message can quote a row).
   */
  private observe(
    outcome: ConsumerOutcome,
    fields: Record<string, unknown>,
    error?: unknown,
  ): void {
    countConsumerMessage(this.consumerName, outcome);
    const line = {
      consumer: this.consumerName,
      outcome,
      ...fields,
      ...(error === undefined ? {} : safeErrorMetadata(error)),
    };
    if (outcome === 'dead_letter') {
      this.baseLogger.error(line, `${this.consumerName} message dead-lettered`);
    } else {
      this.baseLogger.warn(line, `${this.consumerName} message will be retried`);
    }
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
