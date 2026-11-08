import { Injectable } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import { AccountsService } from '@modules/accounts';
import { AuditService } from '@modules/audit';
import { TransactionItemDto, TransactionPageDto } from './transaction-history.dto';
import {
  buildHistorySql,
  encodeHistoryCursor,
  type ParsedHistoryQuery,
} from './transaction-history.query';

@Injectable()
export class TransactionHistoryService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * UC-6. Ownership is checked first and outside any transaction (a refusal is a 404 plus a
   * DENIED audit row that commits on its own). The page and its SUCCESS audit row are one
   * transaction, so a failed audit returns no data (fail-closed, like `account.read`).
   */
  async list(
    userId: string,
    accountId: string,
    query: ParsedHistoryQuery,
    correlationId: string,
  ): Promise<TransactionPageDto> {
    const account = await this.accounts.getOwnedAccount(accountId, {
      userId,
      role: 'customer',
      action: 'account.transactions',
      correlationId,
    });
    return this.tx.run(async manager => {
      const { sql, parameters } = buildHistorySql(account.id, query);
      const rows: TransactionItemDto[] = await manager.query(sql, parameters);
      // Copy field by field: only what is named here can leave the service.
      const items = rows.slice(0, query.limit).map(row => ({
        entryId: row.entryId,
        transferId: row.transferId,
        type: row.type,
        direction: row.direction,
        amount: row.amount,
        balanceAfter: row.balanceAfter,
        counterpartyAccountId: row.counterpartyAccountId,
        createdAt: row.createdAt,
      }));
      await this.audit.record(manager, {
        actor: userId,
        role: 'customer',
        action: 'account.transactions',
        outcome: 'SUCCESS',
        target: { type: 'account', id: account.id },
        correlationId,
        metadata: { id: account.id, count: items.length },
      });
      const more = rows.length > query.limit;
      return {
        items,
        nextCursor: more ? encodeHistoryCursor(items[items.length - 1], query) : null,
      };
    });
  }
}
