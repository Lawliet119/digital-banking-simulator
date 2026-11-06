import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import { AccountsService } from '@modules/accounts';
import { AuditService } from '@modules/audit';
import { OutboxWriter } from '@modules/outbox';
import { ErrorCode } from '@common/errors/error-code.enum';
import {
  creditBalance,
  debitBalance,
  formatBalance,
  formatMoney,
  parseBalance,
  parsePositiveMoney,
} from '@common/money';
import type { TransferCompleted } from '@common/events';
import { DepositDto, DepositResultDto } from './deposit.dto';

const FUNDING = '00000000-0000-4000-8000-000000000001';
interface TransferRow {
  id: string;
  created_at: Date;
}

@Injectable()
export class DepositService {
  constructor(
    private readonly tx: TransactionService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxWriter,
  ) {}

  async deposit(
    actor: string,
    key: string,
    body: DepositDto,
    correlationId: string,
  ): Promise<DepositResultDto> {
    const amount = parsePositiveMoney(body.amount),
      toId = body.toAccountId.toLowerCase();
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          method: 'POST',
          path: '/v1/operator/deposits',
          body: { amount: formatMoney(amount), toAccountId: toId },
        }),
      )
      .digest('hex');
    const outcome = await this.tx.run(async manager => {
      const keys: { idem_key: string }[] = await manager.query(
        `INSERT INTO idempotency_keys(user_id,idem_key,request_hash) VALUES($1,$2,$3)
         ON CONFLICT(user_id,idem_key) DO NOTHING RETURNING idem_key`,
        [actor, key, hash],
      );
      // Safe duplicate barrier only. Exact replay/hash-conflict responses are task DBS-79.
      if (!keys.length) throw new ConflictException('Idempotency key already used');
      const locked = await this.accounts.lockForUpdate([FUNDING, toId], manager);
      const funding = locked.find(a => a.id === FUNDING),
        target = locked.find(a => a.id === toId);
      if (
        !funding ||
        funding.type !== 'SYSTEM' ||
        funding.customerId !== null ||
        funding.status !== 'ACTIVE'
      )
        throw new Error('Funding account unavailable');
      const customerTarget =
        target && target.type !== 'SYSTEM' && target.customerId !== null && target.userId !== null
          ? target
          : undefined;
      const rejected = !customerTarget || customerTarget.status !== 'ACTIVE';
      // Compute before updates. Overflow is an internal capacity failure and rolls back the key.
      const fromBefore = parseBalance(funding.balance);
      const fromAfter = rejected ? undefined : debitBalance(fromBefore, amount);
      const toAfter = rejected
        ? undefined
        : creditBalance(parseBalance(customerTarget.balance), amount);
      const [transfer]: TransferRow[] = await manager.query(
        `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,reject_reason,initiated_by,correlation_id)
         VALUES('DEPOSIT',$1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at`,
        [
          FUNDING,
          customerTarget?.id ?? null,
          formatMoney(amount),
          rejected ? 'REJECTED' : 'COMPLETED',
          rejected ? ErrorCode.ACCOUNT_NOT_ACTIVE : null,
          actor,
          correlationId,
        ],
      );
      if (!rejected && customerTarget && fromAfter !== undefined && toAfter !== undefined) {
        await manager.query(
          `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after)
          VALUES($1,$2,'DEBIT',$4,$5),($1,$3,'CREDIT',$4,$6)`,
          [
            transfer.id,
            FUNDING,
            customerTarget.id,
            formatMoney(amount),
            formatBalance(fromAfter),
            formatBalance(toAfter),
          ],
        );
        await this.accounts.applyBalanceChange(FUNDING, 0n - amount, manager);
        await this.accounts.applyBalanceChange(customerTarget.id, amount, manager);
      }
      await this.audit.record(manager, {
        actor,
        role: 'operator',
        action: 'deposit',
        outcome: rejected ? 'REJECTED' : 'SUCCESS',
        target: { type: 'transfer', id: transfer.id },
        correlationId,
        metadata: rejected ? { id: toId, reason: ErrorCode.ACCOUNT_NOT_ACTIVE } : { id: toId },
      });
      if (!rejected && customerTarget) {
        const event: TransferCompleted = {
          eventId: randomUUID(),
          eventType: 'TransferCompleted',
          occurredAt: transfer.created_at.toISOString(),
          correlationId,
          transferId: transfer.id,
          type: 'DEPOSIT',
          fromAccountId: FUNDING,
          toAccountId: customerTarget.id,
          amount: formatMoney(amount),
          fromBalanceBefore: formatBalance(fromBefore),
          fromAccountCreatedAt: funding.createdAt.toISOString(),
          toAccountCreatedAt: customerTarget.createdAt.toISOString(),
          fromUserId: null,
          toUserId: customerTarget.userId!,
          sameOwner: false,
        };
        await this.outbox.add(manager, event);
      }
      const result = rejected
        ? {
            errorCode: ErrorCode.ACCOUNT_NOT_ACTIVE,
            transferId: transfer.id,
            message: 'Destination account is not active',
          }
        : { transferId: transfer.id, status: 'COMPLETED' as const };
      await manager.query(
        'UPDATE idempotency_keys SET transfer_id=$3,response_code=$4,response_body=$5::jsonb WHERE user_id=$1 AND idem_key=$2',
        [actor, key, transfer.id, rejected ? 422 : 201, JSON.stringify(result)],
      );
      return { rejected, result };
    });
    if (outcome.rejected) throw new UnprocessableEntityException(outcome.result);
    return outcome.result as DepositResultDto;
  }
}
