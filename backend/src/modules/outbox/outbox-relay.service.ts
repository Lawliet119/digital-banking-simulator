import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { TransactionService } from '@database/transaction.service';
import { sqsConfig } from '@config/sqs.config';
import { SqsClient } from '@libs/sqs';
import { runsWorkers } from '@common/app-role/app-role';
import { safeErrorMetadata } from '@common/logging/logging.options';
import { PollingLoop } from '@common/utils/polling-loop';
import { OUTBOX_ROUTES, ROUTED_EVENT_TYPES, type OutboxQueue } from './outbox-routing';
import type { EventType } from '@common/events';

/** ADR-03 and docs/03 §10: a batch is 100 events. */
export const RELAY_BATCH_SIZE = 100;
/** docs/03 §10: poll every 500 ms when idle, so an event waits well under the 1 s budget. */
export const RELAY_IDLE_DELAY_MS = 500;
/**
 * One batch never starts a new event after 15 s. With two queues per event and a 5 s limit per
 * send, a batch is over within 15 + 2 x 5 = 25 s: inside Postgres' idle-in-transaction limit
 * below and inside the 30 s a stopping ECS task gets by default.
 */
export const RELAY_BATCH_BUDGET_MS = 15_000;
export const RELAY_SEND_TIMEOUT_MS = 5_000;
/** Transient send failures in a row after which the batch gives up (SQS is probably down). */
export const RELAY_MAX_TRANSIENT_FAILURES = 3;
/** An event that fails for good is left alone for 30 s, then twice as long, up to 10 minutes. */
export const RELAY_PARK_BASE_MS = 30_000;
const RELAY_PARK_MAX_MS = 10 * 60_000;
const MAX_PARKED = 1000;
/**
 * The transaction stays open while the relay talks to SQS, so Postgres' default idle limit (10 s)
 * must not cut it short. A batch of 100 events is a few round trips, not a minute.
 */
const RELAY_IDLE_IN_TRANSACTION_MS = 60_000;

interface PendingEvent {
  id: string;
  event_type: EventType;
  payload: { correlationId?: unknown };
}

export interface RelayResult {
  /** Events fully sent to every queue that wants them and marked published. */
  published: number;
  /** The last send that failed in this batch; present only when one failed. */
  failure?: unknown;
  /** True when the batch stopped on its time budget with events still to try. */
  truncated?: true;
}

export interface RelayOptions {
  budgetMs?: number;
  sendTimeoutMs?: number;
  /** Clock in milliseconds; a test injects its own. */
  now?: () => number;
}

/** A queue URL that is not configured: it will not fix itself by retrying. */
export class QueueNotConfiguredError extends Error {
  constructor(queue: OutboxQueue) {
    super(`SQS queue URL for ${queue} is not configured`);
    this.name = 'QueueNotConfiguredError';
  }
}

/**
 * Permanent = SQS answered with a 4xx other than 429 (bad parameter, message too long, no such
 * queue) or the queue is not configured: the same event fails again every time. Everything else
 * (timeout, network, 429, 5xx) is worth another try.
 */
export function classifySendError(error: unknown): 'transient' | 'permanent' {
  if (error instanceof QueueNotConfiguredError) return 'permanent';
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
    ?.httpStatusCode;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429
    ? 'permanent'
    : 'transient';
}

/**
 * How long the loop waits after a run. Events that did get out keep the normal pace even when
 * another event failed, so one bad event does not slow the healthy ones down. Only a run that
 * sent nothing because of a transient failure throws, which makes the loop back off.
 */
export function relayDelayMs(result: RelayResult): number {
  if (
    result.failure !== undefined &&
    result.published === 0 &&
    !result.truncated &&
    classifySendError(result.failure) === 'transient'
  ) {
    throw result.failure instanceof Error ? result.failure : new Error('Outbox relay send failed');
  }
  return result.published >= RELAY_BATCH_SIZE || result.truncated ? 0 : RELAY_IDLE_DELAY_MS;
}

/**
 * Moves events from `outbox_events` to SQS (docs/03 §10), at least once.
 *
 * It selects pending rows with `FOR UPDATE SKIP LOCKED`, so several worker tasks never take the
 * same row, sends each event to every queue in its route, and marks the row published in the same
 * transaction. This is the one place allowed to call SQS inside a transaction (CONTRIBUTING §5):
 * it locks only `outbox_events` rows, never accounts, and a repeated send is harmless because
 * consumers deduplicate on `eventId`. A crash after a send and before the commit sends the event
 * again, which is why delivery is at-least-once and not exactly-once.
 *
 * Order is not kept when an event fails (no consumer depends on it, docs/03 §10): a failed event
 * stays pending and the batch goes on with the next one, so one bad event does not block the
 * rest. A failure that will repeat (4xx) parks the event in memory for a while so it stops
 * taking a place in every batch; three transient failures in a row end the batch. The events
 * sent before are always committed. An event whose type has no route stays pending until a
 * release that knows it (BL-010); the unpublished-age alarm is what notices it.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayService.name);
  private stopping = false;
  /** Outbox id -> when it may be tried again, and how many times it already failed for good. */
  private readonly parked = new Map<string, { retryAt: number; attempts: number }>();
  private readonly relayLoop = new PollingLoop(
    async () => relayDelayMs(await this.relayOnce()),
    error => this.logger.error(safeErrorMetadata(error), 'Outbox relay failed'),
  );
  constructor(
    private readonly tx: TransactionService,
    private readonly sqs: SqsClient,
    @Inject(sqsConfig.KEY) private readonly config: ConfigType<typeof sqsConfig>,
  ) {}

  onApplicationBootstrap(): void {
    // Producers run in every role; only the worker (and `both`) moves events on.
    if (!runsWorkers()) return;
    this.stopping = false;
    this.relayLoop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    // The batch in flight finishes the event it is on, commits, and starts no other.
    this.stopping = true;
    await this.relayLoop.stop();
  }

  /** One batch. Never throws for a failed send: it reports it in `failure` after committing. */
  async relayOnce(limit = RELAY_BATCH_SIZE, options: RelayOptions = {}): Promise<RelayResult> {
    const now = options.now ?? Date.now;
    const budgetMs = options.budgetMs ?? RELAY_BATCH_BUDGET_MS;
    const sendTimeoutMs = options.sendTimeoutMs ?? RELAY_SEND_TIMEOUT_MS;
    const started = now();
    const parkedIds = [...this.parked].filter(([, p]) => p.retryAt > started).map(([id]) => id);
    return this.tx.run(
      async manager => {
        const pending: PendingEvent[] = await manager.query(
          `SELECT id, event_type, payload FROM outbox_events
           WHERE published_at IS NULL AND event_type = ANY($2::text[]) AND id <> ALL($3::bigint[])
           ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [limit, ROUTED_EVENT_TYPES, parkedIds],
        );
        const sent: string[] = [];
        let failure: unknown;
        let transientInARow = 0;
        let truncated = false;
        for (const event of pending) {
          if (this.stopping) break;
          if (now() - started >= budgetMs) {
            truncated = true;
            break;
          }
          try {
            const body = JSON.stringify(event.payload);
            for (const queue of OUTBOX_ROUTES[event.event_type]) {
              await this.sqs.send(
                this.queueUrl(queue),
                body,
                {
                  eventType: event.event_type,
                  ...(typeof event.payload.correlationId === 'string'
                    ? { correlationId: event.payload.correlationId }
                    : {}),
                },
                { timeoutMs: sendTimeoutMs },
              );
            }
            sent.push(event.id);
            transientInARow = 0;
            this.parked.delete(event.id);
          } catch (error) {
            failure = error;
            const kind = classifySendError(error);
            this.logger.warn(
              { ...safeErrorMetadata(error), outboxId: event.id, kind },
              'Outbox event could not be sent',
            );
            if (kind === 'permanent') this.park(event.id, now());
            else if (++transientInARow >= RELAY_MAX_TRANSIENT_FAILURES) break;
          }
        }
        if (sent.length > 0) {
          await manager.query(
            'UPDATE outbox_events SET published_at = clock_timestamp() WHERE id = ANY($1::bigint[])',
            [sent],
          );
        }
        return {
          published: sent.length,
          ...(failure === undefined ? {} : { failure }),
          ...(truncated ? { truncated: true as const } : {}),
        };
      },
      // A deadlock retry would send the batch twice for nothing; the next poll retries anyway.
      { maxRetries: 0, idleInTransactionTimeoutMs: RELAY_IDLE_IN_TRANSACTION_MS },
    );
  }

  private park(id: string, at: number): void {
    const known = this.parked.get(id);
    if (!known && this.parked.size >= MAX_PARKED) return;
    const attempts = (known?.attempts ?? 0) + 1;
    const wait = Math.min(RELAY_PARK_BASE_MS * 2 ** (attempts - 1), RELAY_PARK_MAX_MS);
    this.parked.set(id, { retryAt: at + wait, attempts });
  }

  private queueUrl(queue: OutboxQueue): string {
    const url = queue === 'risk' ? this.config.riskQueueUrl : this.config.notificationQueueUrl;
    if (!url) throw new QueueNotConfiguredError(queue);
    return url;
  }
}
