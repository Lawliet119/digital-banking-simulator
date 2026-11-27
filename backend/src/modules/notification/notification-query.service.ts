import { Injectable } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import {
  buildNotificationSql,
  encodeNotificationCursor,
  type ParsedNotificationQuery,
} from './notification-query';
import type { NotificationItemDto, NotificationPageDto } from './notification-view.dto';

@Injectable()
export class NotificationQueryService {
  constructor(private readonly tx: TransactionService) {}

  /** The caller's own notices. Read only: the api role has no write grant on the table. */
  async list(userId: string, query: ParsedNotificationQuery): Promise<NotificationPageDto> {
    const { sql, parameters } = buildNotificationSql(userId, query);
    const rows = await this.tx.run<NotificationItemDto[]>(manager =>
      manager.query(sql, parameters),
    );
    // Copy field by field: only what is named here can leave the service.
    const items = rows.slice(0, query.limit).map(row => ({
      id: row.id,
      kind: row.kind,
      message: row.message,
      occurredAt: row.occurredAt,
    }));
    return {
      items,
      nextCursor:
        rows.length > query.limit ? encodeNotificationCursor(items[items.length - 1]) : null,
    };
  }
}
