import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { EntityManager } from 'typeorm';
import { sqsConfig } from '@config/sqs.config';
import type { DomainEvent } from '@common/events';
import { ConsumerBase, dlqUrlFor } from '@common/messaging';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';

/** `processed_events.consumer` of this module. */
export const NOTIFICATION_CONSUMER = 'notification';

export { dlqUrlFor };

/**
 * Consumer of `notification-events` (v1: the "notification" is a log line, docs/03 §6.3). The frame
 * (idempotency, DLQ, retry limit, worker-only polling) is `ConsumerBase`; this class only says what
 * one event writes. Nothing here can affect the transfer, which was committed long before (D-4).
 */
@Injectable()
export class NotificationConsumer extends ConsumerBase {
  protected readonly consumerName = NOTIFICATION_CONSUMER;
  private readonly logger = new Logger(NotificationConsumer.name);

  constructor(
    tx: TransactionService,
    sqs: SqsClient,
    pino: PinoLogger,
    @Inject(sqsConfig.KEY) private readonly config: ConfigType<typeof sqsConfig>,
  ) {
    super(tx, sqs, pino);
  }

  protected queueUrl(): string | undefined {
    return this.config.notificationQueueUrl;
  }

  protected async apply(event: DomainEvent, manager: EntityManager): Promise<void> {
    const kind =
      event.eventType === 'TransferCompleted' ? 'transfer_completed' : 'account_status_changed';
    const message =
      event.eventType === 'TransferCompleted'
        ? 'Giao dịch đã hoàn tất'
        : 'Trạng thái tài khoản đã thay đổi';
    await manager.query(
      'INSERT INTO notification_log(event_id,kind,user_id,message) VALUES($1,$2,NULL,$3)',
      [event.eventId, kind, message],
    );
  }

  protected override onCommitted(event: DomainEvent): void {
    // Ids and the type only: no amounts, no account numbers, and never a fraud reason (BR-13).
    this.logger.log(
      { eventId: event.eventId, eventType: event.eventType, correlationId: event.correlationId },
      'Notification sent (simulated)',
    );
  }
}
