import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { AccountHolderReader } from '@modules/accounts';
import { LedgerLineReader, ledgerLineKey } from '@modules/ledger';
import {
  buildNotificationSql,
  encodeNotificationCursor,
  MARK_READ_SQL,
  UNREAD_COUNT_SQL,
  type NotificationRow,
  type ParsedNotificationQuery,
} from './notification-query';
import type {
  NotificationItemDto,
  NotificationPageDto,
  NotificationReadDto,
} from './notification-view.dto';

@Injectable()
export class NotificationQueryService {
  constructor(
    private readonly tx: TransactionService,
    private readonly holders: AccountHolderReader,
    private readonly lines: LedgerLineReader,
  ) {}

  /** The caller's own notices, with the transfer behind each one. */
  async list(userId: string, query: ParsedNotificationQuery): Promise<NotificationPageDto> {
    const { sql, parameters } = buildNotificationSql(userId, query);
    return this.tx.run<NotificationPageDto>(async manager => {
      const rows: NotificationRow[] = await manager.query(sql, parameters);
      const items = await this.view(manager, rows.slice(0, query.limit));
      return {
        items,
        nextCursor:
          rows.length > query.limit
            ? encodeNotificationCursor(items[items.length - 1], query.filter)
            : null,
        unreadCount: await this.unread(manager, userId),
      };
    });
  }

  /**
   * Marks the caller's notices as read, from `upToId` down in list order, so a notice that arrived
   * after the page was shown stays unread. Someone else's id changes nothing.
   */
  async markRead(userId: string, upToId: string): Promise<NotificationReadDto> {
    return this.tx.run<NotificationReadDto>(async manager => {
      await manager.query(MARK_READ_SQL, [userId, upToId]);
      return { unreadCount: await this.unread(manager, userId) };
    });
  }

  private async unread(manager: EntityManager, userId: string): Promise<number> {
    const rows: { count: number }[] = await manager.query(UNREAD_COUNT_SQL, [userId]);
    return rows[0].count;
  }

  private async view(
    manager: EntityManager,
    rows: NotificationRow[],
  ): Promise<NotificationItemDto[]> {
    const holders = await this.holders.holdersOf(
      manager,
      rows.flatMap(row =>
        [row.accountId, row.counterpartyAccountId].filter((id): id is string => id !== null),
      ),
    );
    const lines = await this.lines.linesOf(
      manager,
      rows.flatMap(row =>
        row.transferId && row.accountId
          ? [{ transferId: row.transferId, accountId: row.accountId }]
          : [],
      ),
    );
    // Copy field by field: only what is named here can leave the service.
    return rows.map(row => {
      const line =
        row.transferId && row.accountId
          ? lines.get(ledgerLineKey(row.transferId, row.accountId))
          : undefined;
      const other = row.counterpartyAccountId ? holders.get(row.counterpartyAccountId) : undefined;
      return {
        id: row.id,
        kind: row.kind,
        message: row.message,
        occurredAt: row.occurredAt,
        read: row.read,
        accountNumber: row.accountId ? (holders.get(row.accountId)?.accountNumber ?? null) : null,
        transfer:
          line && row.transferId && row.direction
            ? {
                transferId: row.transferId,
                direction: row.direction,
                amount: line.amount,
                balanceAfter: line.balanceAfter,
                counterpartyName: other?.ownerName ?? null,
                counterpartyAccountNumber: other?.ownerName ? other.accountNumber : null,
              }
            : null,
      };
    });
  }
}
