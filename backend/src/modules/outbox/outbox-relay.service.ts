import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
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
 * Failed sends of one event, judged permanent (see {@link quarantineCodeOf}), after which the
 * relay quarantines it (BL-181): `quarantined_at` is set and no poll selects the row again. With the
 * park above (30, 60, 120, 240 s) the fifth failure comes about 7.5 minutes after the first.
 */
export const RELAY_QUARANTINE_AFTER_ATTEMPTS = 5;
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
  /** Permanent failures after which an event is quarantined; a test lowers it. */
  quarantineAfterAttempts?: number;
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

/** SQS says the queue is missing: a deployment fault, not a fault of the event. */
const QUEUE_MISSING = /NonExistentQueue|QueueDoesNotExist/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,59}$/;

/**
 * The code stored in `outbox_events.last_error_code` when the failure is the event's own fault
 * (BL-181), or `undefined` when it is not and the event must stay in the normal retry loop. Only
 * SQS answers 400 and 413 qualify (a body or an attribute SQS refuses: too long, characters it
 * does not accept): the same event fails again however often it is sent, and every other event
 * is unaffected. A 403, a 404, a missing queue or a queue URL that is not configured are faults of
 * the deployment: they would hit every event, quarantining all of them for a mistake that one
 * deploy fixes, so those events are only set aside in memory and the outbox-age alarm reports them.
 *
 * The code is `SQS_<status>` plus the error name when the SDK gave a plain identifier
 * (`SQS_400_InvalidParameterValue`). It never holds the error message, which can quote the payload.
 */
export function quarantineCodeOf(error: unknown): string | undefined {
  if (classifySendError(error) !== 'permanent' || error instanceof QueueNotConfiguredError) {
    return undefined;
  }
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  if (status !== 400 && status !== 413) return undefined;
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof name !== 'string' || !ERROR_NAME.test(name)) return `SQS_${status}`;
  if (QUEUE_MISSING.test(name)) return undefined;
  return name === 'Error' ? `SQS_${status}` : `SQS_${status}_${name}`;
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
 * The relay's poll: pending rows of the routed types in identity order, skipping rows another worker
 * holds and the ids parked after a send failure. Exported so DBS-171 can `EXPLAIN` this exact text.
 */
export const PENDING_BATCH_SQL = `SELECT id, event_type, payload FROM outbox_events
           WHERE published_at IS NULL AND quarantined_at IS NULL
             AND event_type = ANY($2::text[]) AND id <> ALL($3::bigint[])
           ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`;

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
 * taking a place in every batch, and when it is the event's own fault (SQS 400/413) it is also
 * counted in the row: after {@link RELAY_QUARANTINE_AFTER_ATTEMPTS} of them the row is quarantined
 * for good (BL-181), which survives a restart and is what the quarantine gauge and its alarm
 * count; three transient failures in a row end the batch. The events
 * sent before are always committed. An event whose type has no route stays pending until a
 * release that knows it (BL-010); the unpublished-age alarm is what notices it.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, BeforeApplicationShutdown {
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

  async beforeApplicationShutdown(): Promise<void> {
    // The batch in flight finishes the event it is on, commits, and starts no other. This is
    // `beforeApplicationShutdown`, not `onApplicationShutdown`: SqsClient destroys its SDK client in
    // `onApplicationShutdown` (BL-249), so the loop must be over by then. Nest runs the hooks in
    // phases (every onModuleDestroy, then every beforeApplicationShutdown, then every
    // onApplicationShutdown), so this holds whatever the module order.
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
        const pending: PendingEvent[] = await manager.query(PENDING_BATCH_SQL, [
          limit,
          ROUTED_EVENT_TYPES,
          parkedIds,
        ]);
        const sent: string[] = [];
        const failedForGood: { id: string; code: string; event: PendingEvent }[] = [];
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
              {
                ...safeErrorMetadata(error),
                outboxId: event.id,
                kind,
                // The relay runs outside any request, so name the event's chain explicitly.
                ...(typeof event.payload.correlationId === 'string'
                  ? { correlationId: event.payload.correlationId }
                  : {}),
              },
              'Outbox event could not be sent',
            );
            if (kind === 'permanent') {
              this.park(event.id, now());
              const code = quarantineCodeOf(error);
              if (code !== undefined) failedForGood.push({ id: event.id, code, event });
            } else if (++transientInARow >= RELAY_MAX_TRANSIENT_FAILURES) break;
          }
        }
        if (sent.length > 0) {
          await manager.query(
            'UPDATE outbox_events SET published_at = clock_timestamp() WHERE id = ANY($1::bigint[])',
            [sent],
          );
        }
        await this.recordFailures(manager, failedForGood, options.quarantineAfterAttempts);
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

  /**
   * Counts the failures that will repeat in the rows themselves, in the batch transaction (the rows
   * are locked by it already), and quarantines the ones that reached the limit. Only a code and
   * a count are written: no message and no payload.
   */
  private async recordFailures(
    manager: EntityManager,
    failed: { id: string; code: string; event: PendingEvent }[],
    limit = RELAY_QUARANTINE_AFTER_ATTEMPTS,
  ): Promise<void> {
    if (failed.length === 0) return;
    const rows: { id: string; attempts: number; quarantined: boolean }[] = await manager.query(
      // A data-modifying CTE read by a SELECT: TypeORM hands back `[rows, count]` for a bare
      // UPDATE ... RETURNING, but plain rows for a SELECT.
      `WITH updated AS (
         UPDATE outbox_events AS o
            SET attempts = o.attempts + 1,
                last_attempt_at = clock_timestamp(),
                last_error_code = f.code,
                quarantined_at = CASE WHEN o.attempts + 1 >= $3 THEN clock_timestamp() END
           FROM unnest($1::bigint[], $2::text[]) AS f(id, code)
          WHERE o.id = f.id
          RETURNING o.id, o.attempts, o.quarantined_at IS NOT NULL AS quarantined)
       SELECT id, attempts, quarantined FROM updated`,
      [failed.map(f => f.id), failed.map(f => f.code), limit],
    );
    for (const row of rows) {
      if (!row.quarantined) continue;
      const entry = failed.find(f => String(f.id) === String(row.id));
      this.parked.delete(String(row.id));
      this.logger.warn(
        {
          outboxId: String(row.id),
          attempts: row.attempts,
          errorCode: entry?.code,
          eventType: entry?.event.event_type,
          ...(typeof entry?.event.payload.correlationId === 'string'
            ? { correlationId: entry.event.payload.correlationId }
            : {}),
        },
        'Outbox event quarantined',
      );
    }
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
