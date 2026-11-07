import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import { AuditService } from '@modules/audit';
import { ErrorCode } from '@common/errors/error-code.enum';
import { type CustomerAccountType, OpenedAccountDto } from './open-account.dto';

type OpenedRow = Omit<OpenedAccountDto, 'createdAt' | 'updatedAt'> & {
  createdAt: Date;
  updatedAt: Date;
};
type Outcome =
  { kind: 'created'; account: OpenedAccountDto } | { kind: 'limit' } | { kind: 'missing' };

const MAX_CUSTOMER_ACCOUNTS = 3;

@Injectable()
export class AccountOpeningService {
  constructor(
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  async open(
    userId: string,
    type: CustomerAccountType,
    correlationId: string,
  ): Promise<OpenedAccountDto> {
    const outcome = await this.tx.run<Outcome>(async manager => {
      // The parent serializes openings even when this customer has no accounts to lock yet.
      const customers: { id: string }[] = await manager.query(
        'SELECT id FROM customers WHERE user_id=$1 FOR UPDATE',
        [userId],
      );
      if (!customers[0]) {
        // A missing profile is a business rejection, not a permission denial: no other write
        // happens, so REJECTED goes in this transaction and the 404 is thrown after commit.
        await this.audit.record(manager, {
          actor: userId,
          role: 'customer',
          action: 'account.open',
          outcome: 'REJECTED',
          target: { type: 'user', id: userId },
          correlationId,
          metadata: { id: userId },
        });
        return { kind: 'missing' };
      }
      const customerId = customers[0].id;
      // A separate READ COMMITTED statement sees accounts committed by the lock's previous holder.
      const [state]: { count: number }[] = await manager.query(
        'SELECT count(*)::int AS count FROM accounts WHERE customer_id=$1',
        [customerId],
      );
      if (state.count >= MAX_CUSTOMER_ACCOUNTS) {
        await this.audit.record(manager, {
          actor: userId,
          role: 'customer',
          action: 'account.open',
          outcome: 'REJECTED',
          target: { type: 'customer', id: customerId },
          correlationId,
          metadata: { reason: ErrorCode.ACCOUNT_LIMIT_REACHED, count: state.count },
        });
        // Throw only after commit, so the rejection audit survives the HTTP409.
        return { kind: 'limit' };
      }
      const [row]: OpenedRow[] = await manager.query(
        `INSERT INTO accounts (customer_id,type) VALUES ($1,$2)
         RETURNING id,type,status,balance::text,created_at AS "createdAt",updated_at AS "updatedAt"`,
        [customerId, type],
      );
      await this.audit.record(manager, {
        actor: userId,
        role: 'customer',
        action: 'account.open',
        outcome: 'SUCCESS',
        target: { type: 'account', id: row.id },
        correlationId,
        metadata: { id: row.id },
      });
      return {
        kind: 'created',
        account: {
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      };
    });
    if (outcome.kind === 'limit') {
      throw new ConflictException({
        errorCode: ErrorCode.ACCOUNT_LIMIT_REACHED,
        message: 'Customer account limit reached',
      });
    }
    if (outcome.kind === 'missing') throw new NotFoundException('Customer profile not found');
    return outcome.account;
  }
}
