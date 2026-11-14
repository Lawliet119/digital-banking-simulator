import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import { sqsConfig } from '@config/sqs.config';
import type { DomainEvent } from '@common/events';
import { ConsumerBase, dlqUrlFor } from '@common/messaging';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import { AuditService } from '@modules/audit';

/** `processed_events.consumer` of this module. */
export const NOTIFICATION_CONSUMER = 'notification';

export { dlqUrlFor };

interface Notice {
  userId: string;
  kind: 'transfer_completed' | 'account_status_changed';
  message: string;
}

/**
 * Who is told what. The texts are fixed sentences chosen from the event type and status only: no
 * amount, no account number, and nothing from the event that could carry a reason, so a fraud
 * reason cannot reach a customer (BR-13). Whoever owns both ends of a transfer is told once.
 */
export function noticesFor(event: DomainEvent): Notice[] {
  if (event.eventType === 'AccountStatusChanged') {
    return [
      {
        userId: event.ownerUserId,
        kind: 'account_status_changed',
        message:
          event.newStatus === 'LOCKED'
            ? 'Tài khoản của bạn đã bị tạm khóa. Vui lòng liên hệ ngân hàng để được hỗ trợ'
            : 'Tài khoản của bạn đã được mở khóa',
      },
    ];
  }
  const received: Notice = {
    userId: event.toUserId,
    kind: 'transfer_completed',
    message:
      event.type === 'DEPOSIT'
        ? 'Tài khoản của bạn vừa được nạp tiền'
        : 'Tài khoản của bạn vừa nhận tiền',
  };
  if (event.type === 'DEPOSIT') return [received];
  const sent: Notice = {
    userId: event.fromUserId,
    kind: 'transfer_completed',
    message: 'Bạn đã chuyển tiền thành công',
  };
  return event.fromUserId === event.toUserId ? [sent] : [sent, received];
}

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
    @Inject(sqsConfig.KEY) private readonly config: ConfigType<typeof sqsConfig>,
    private readonly audit: AuditService,
  ) {
    super(tx, sqs);
  }

  protected queueUrl(): string | undefined {
    return this.config.notificationQueueUrl;
  }

  protected async apply(event: DomainEvent, manager: EntityManager): Promise<void> {
    const notices = noticesFor(event);
    for (const notice of notices) {
      await manager.query(
        // occurred_at is the time of the event, not of this processing (BL-211): delivery is not
        // ordered, so readers sort by it (`ORDER BY occurred_at, id`) and not by id or created_at.
        `INSERT INTO notification_log(event_id,kind,user_id,message,correlation_id,occurred_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          event.eventId,
          notice.kind,
          notice.userId,
          notice.message,
          event.correlationId,
          event.occurredAt,
        ],
      );
    }
    // DBS-135 (AC-8.2): the auditor reads audit_log only, so the notification step of a chain is
    // one audit line under the event's correlationId, in the same transaction as the notices. Only
    // the count: never a reason or a text (BR-13). A failing INSERT rolls back the notices too.
    await this.audit.record(manager, {
      actor: null,
      role: 'worker',
      action: 'notification.sent',
      outcome: 'SUCCESS',
      target:
        event.eventType === 'AccountStatusChanged'
          ? { type: 'account', id: event.accountId }
          : { type: 'transfer', id: event.transferId },
      correlationId: event.correlationId,
      metadata: { count: notices.length },
    });
  }

  protected override onCommitted(event: DomainEvent): void {
    // Ids and the type only: no amounts, no account numbers, and never a fraud reason (BR-13).
    this.logger.log(
      { eventId: event.eventId, eventType: event.eventType, correlationId: event.correlationId },
      'Notification sent (simulated)',
    );
  }
}
