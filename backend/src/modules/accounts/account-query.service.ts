import { Injectable, NotFoundException } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import { AuditReason, AuditService } from '@modules/audit';
import { AccountViewDto, type AccountReadRow, toAccountView } from './account-view.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNED_SELECT = `SELECT a.id,a.type,a.status,a.balance::text,
  a.created_at AS "createdAt",a.updated_at AS "updatedAt"
  FROM accounts a JOIN customers c ON c.id=a.customer_id WHERE c.user_id=$1`;

@Injectable()
export class AccountQueryService {
  constructor(
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  list(userId: string, correlationId: string): Promise<AccountViewDto[]> {
    return this.tx.run(async manager => {
      const rows: AccountReadRow[] = await manager.query(
        OWNED_SELECT + ' ORDER BY a.created_at,a.id',
        [userId],
      );
      const accounts = rows.map(toAccountView);
      await this.audit.record(manager, {
        actor: userId,
        role: 'customer',
        action: 'account.list',
        outcome: 'SUCCESS',
        target: { type: 'user', id: userId },
        correlationId,
        metadata: { count: accounts.length },
      });
      return accounts;
    });
  }

  async get(userId: string, accountId: string, correlationId: string): Promise<AccountViewDto> {
    const normalized = UUID.test(accountId) ? accountId.toLowerCase() : undefined;
    const account = await this.tx.run(async manager => {
      if (!normalized) return undefined;
      const rows: AccountReadRow[] = await manager.query(OWNED_SELECT + ' AND a.id=$2::uuid', [
        userId,
        normalized,
      ]);
      if (!rows[0]) return undefined;
      const result = toAccountView(rows[0]);
      await this.audit.record(manager, {
        actor: userId,
        role: 'customer',
        action: 'account.read',
        outcome: 'SUCCESS',
        target: { type: 'account', id: result.id },
        correlationId,
        metadata: { id: result.id },
      });
      return result;
    });
    if (account) return account;
    // Outside the read transaction: denial survives404 and respects PR54 nested-tx protection.
    // Never persist an unvalidated path value (which may itself contain PII).
    await this.audit.recordDenied({
      actor: userId,
      role: 'customer',
      action: 'account.read',
      target: normalized ? { type: 'account', id: normalized } : { type: 'user', id: userId },
      correlationId,
      metadata: { reason: AuditReason.NOT_OWNER },
    });
    throw new NotFoundException('Account not found');
  }
}
