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
import { type BatchResult, SqsClient } from '@libs/sqs';
import { runsWorkers } from '@common/app-role/app-role';
import { validateEvent } from '@common/events';
import { safeErrorMetadata } from '@common/logging/logging.options';
import { PollingLoop } from '@common/utils/polling-loop';

/** `processed_events.consumer` of this module. */
export const NOTIFICATION_CONSUMER = 'notification';
const LONG_POLL_SECONDS = 20;

/** `notification-events` -> `notification-events-dlq` (docs/03 §10: each queue has its own DLQ). */
export function dlqUrlFor(queueUrl: string): string {
  return `${queueUrl}-dlq`;
}

/**
 * Consumer of `notification-events` (v1: the "notification" is a log line, docs/03 §6.3).
 *
 * Idempotent: it records `(consumer, eventId)` in `processed_events` first, and only the delivery
 * that inserted the row notifies, so a redelivered event is acknowledged and ignored. A message
 * that is not a valid event is not acknowledged: SQS redelivers it and, after `maxReceiveCount`
 * receives, moves it to the DLQ (a body that is not even JSON goes there at once). Nothing here
 * can affect the transfer, which was committed long before (D-4).
 */
@Injectable()
export class NotificationConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationConsumer.name);
  private readonly loop = new PollingLoop(
    async () => {
      await this.consumeOnce();
      return 0;
    },
    error => this.logger.error(safeErrorMetadata(error), 'Notification consumer failed'),
  );

  constructor(
    private readonly tx: TransactionService,
    private readonly sqs: SqsClient,
    @Inject(sqsConfig.KEY) private readonly config: ConfigType<typeof sqsConfig>,
  ) {}

  onApplicationBootstrap(): void {
    if (runsWorkers()) this.loop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /** One receive and handle of a batch; failed messages stay on the queue. */
  consumeOnce(waitTimeSeconds = LONG_POLL_SECONDS): Promise<BatchResult[]> {
    const queue = this.config.notificationQueueUrl;
    if (!queue) throw new Error('SQS_NOTIFICATION_QUEUE_URL is not configured');
    return this.sqs.processBatch(queue, dlqUrlFor(queue), body => this.handle(body), {
      waitTimeSeconds,
    });
  }

  /** Throws for an invalid event, so the message is not acknowledged. */
  async handle(body: unknown): Promise<void> {
    const checked = validateEvent(body);
    if (!checked.ok) throw new Error('Invalid event on the notification queue');
    const event = checked.event;
    const first = await this.tx.run(async manager => {
      const inserted: unknown[] = await manager.query(
        `INSERT INTO processed_events(consumer,event_id) VALUES($1,$2)
         ON CONFLICT(consumer,event_id) DO NOTHING RETURNING event_id`,
        [NOTIFICATION_CONSUMER, event.eventId],
      );
      return inserted.length > 0;
    });
    if (!first) return;
    // Ids and the type only: no amounts, no account numbers, and never a fraud reason (BR-13).
    this.logger.log(
      { eventId: event.eventId, eventType: event.eventType, correlationId: event.correlationId },
      'Notification sent (simulated)',
    );
  }
}
