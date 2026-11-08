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
const CLEANUP_EVERY_MS = 60 * 60 * 1000;
const RETENTION_DAYS = 7;
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
  /** The first send that failed. Events before it are published, the rest stay pending. */
  failure?: unknown;
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
 * Order is kept per run: the first failed send stops the batch, the events before it are committed
 * as published and the failed one stays first in line. An event whose type has no route stays
 * pending until a release that knows it (BL-010); the unpublished-age alarm is what notices it.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly relayLoop = new PollingLoop(
    async () => {
      const { published, failure } = await this.relayOnce();
      if (failure !== undefined) {
        throw failure instanceof Error ? failure : new Error('Outbox relay send failed');
      }
      return published >= RELAY_BATCH_SIZE ? 0 : RELAY_IDLE_DELAY_MS;
    },
    error => this.logger.error(safeErrorMetadata(error), 'Outbox relay failed'),
  );
  private readonly cleanupLoop = new PollingLoop(
    async () => {
      await this.deleteOldRows();
      return CLEANUP_EVERY_MS;
    },
    error => this.logger.error(safeErrorMetadata(error), 'Outbox cleanup failed'),
    CLEANUP_EVERY_MS,
  );

  constructor(
    private readonly tx: TransactionService,
    private readonly sqs: SqsClient,
    @Inject(sqsConfig.KEY) private readonly config: ConfigType<typeof sqsConfig>,
  ) {}

  onApplicationBootstrap(): void {
    // Producers run in every role; only the worker (and `both`) moves events on.
    if (!runsWorkers()) return;
    this.relayLoop.start();
    this.cleanupLoop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.relayLoop.stop(), this.cleanupLoop.stop()]);
  }

  /** One batch. Never throws for a failed send: it reports it in `failure` after committing. */
  async relayOnce(limit = RELAY_BATCH_SIZE): Promise<RelayResult> {
    return this.tx.run(
      async manager => {
        const pending: PendingEvent[] = await manager.query(
          `SELECT id, event_type, payload FROM outbox_events
           WHERE published_at IS NULL AND event_type = ANY($2::text[])
           ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [limit, ROUTED_EVENT_TYPES],
        );
        const sent: string[] = [];
        let failure: unknown;
        for (const event of pending) {
          try {
            const body = JSON.stringify(event.payload);
            for (const queue of OUTBOX_ROUTES[event.event_type]) {
              await this.sqs.send(this.queueUrl(queue), body, {
                eventType: event.event_type,
                ...(typeof event.payload.correlationId === 'string'
                  ? { correlationId: event.payload.correlationId }
                  : {}),
              });
            }
            sent.push(event.id);
          } catch (error) {
            failure = error;
            break;
          }
        }
        if (sent.length > 0) {
          await manager.query(
            'UPDATE outbox_events SET published_at = clock_timestamp() WHERE id = ANY($1::bigint[])',
            [sent],
          );
        }
        return { published: sent.length, ...(failure === undefined ? {} : { failure }) };
      },
      // A deadlock retry would send the batch twice for nothing; the next poll retries anyway.
      { maxRetries: 0, idleInTransactionTimeoutMs: RELAY_IDLE_IN_TRANSACTION_MS },
    );
  }

  /** Published events and processed-event marks older than the retention window (docs/03 §10). */
  async deleteOldRows(): Promise<number> {
    return this.tx.run(async manager => {
      const [outbox]: { count: number }[] = await manager.query(
        `WITH gone AS (
           DELETE FROM outbox_events
           WHERE published_at IS NOT NULL AND published_at < now() - make_interval(days => $1)
           RETURNING 1)
         SELECT count(*)::int AS count FROM gone`,
        [RETENTION_DAYS],
      );
      await manager.query(
        'DELETE FROM processed_events WHERE processed_at < now() - make_interval(days => $1)',
        [RETENTION_DAYS],
      );
      return outbox.count;
    });
  }

  private queueUrl(queue: OutboxQueue): string {
    const url = queue === 'risk' ? this.config.riskQueueUrl : this.config.notificationQueueUrl;
    if (!url) throw new Error(`SQS queue URL for ${queue} is not configured`);
    return url;
  }
}
