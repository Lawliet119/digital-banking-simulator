import { Injectable, NotFoundException } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import { AuditReason, AuditService } from '@modules/audit';
import { ErrorCode } from '@common/errors/error-code.enum';
import { AccountLookupDto } from './account-lookup.dto';
import { AccountViewDto, type AccountReadRow, toAccountView } from './account-view.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNED_SELECT = `SELECT a.id,a.account_number AS "accountNumber",a.type,a.status,a.balance::text,
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

  /**
   * Who owns this account number, for the confirm step of a transfer. Any customer may ask, so the
   * answer is only the id, the number and the owner's name. A miss and a SYSTEM account (no owner,
   * so no `customers` row to join) give the same 404. The hit and its audit row are one
   * transaction (fail-closed, like `account.read`); a miss writes a REJECTED row, so a walk through
   * the number space leaves a trail, and the 404 is thrown after the commit.
   */
  async lookup(
    userId: string,
    accountNumber: string,
    correlationId: string,
  ): Promise<AccountLookupDto> {
    const found = await this.tx.run(async manager => {
      const rows: AccountLookupDto[] = await manager.query(
        `SELECT a.id AS "accountId", a.account_number AS "accountNumber", c.full_name AS "ownerName"
         FROM accounts a JOIN customers c ON c.id=a.customer_id WHERE a.account_number=$1`,
        [accountNumber],
      );
      const row = rows[0];
      await this.audit.record(manager, {
        actor: userId,
        role: 'customer',
        action: 'account.lookup',
        outcome: row ? 'SUCCESS' : 'REJECTED',
        target: row ? { type: 'account', id: row.accountId } : { type: 'user', id: userId },
        correlationId,
        metadata: row ? { id: row.accountId } : { reason: ErrorCode.ACCOUNT_NOT_FOUND },
      });
      // Field by field: only what is named here can leave the service.
      return row
        ? { accountId: row.accountId, accountNumber: row.accountNumber, ownerName: row.ownerName }
        : undefined;
    });
    if (found) return found;
    throw new NotFoundException({
      errorCode: ErrorCode.ACCOUNT_NOT_FOUND,
      message: 'Account not found',
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
