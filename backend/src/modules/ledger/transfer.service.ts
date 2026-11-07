import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import { AccountsService } from '@modules/accounts';
import { AuditReason, AuditService } from '@modules/audit';
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
import { TransferDto, TransferResultDto } from './transfer.dto';

const FUNDING_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

class SourceOwnershipChangedError extends Error {}
interface TransferRow {
  id: string;
  created_at: Date;
}

@Injectable()
export class TransferService {
  constructor(
    private readonly tx: TransactionService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxWriter,
  ) {}

  async transfer(
    actor: string,
    key: string,
    body: TransferDto,
    correlationId: string,
  ): Promise<TransferResultDto> {
    const fromId = body.fromAccountId.toLowerCase(),
      toId = body.toAccountId.toLowerCase();
    if (fromId === toId) throw new BadRequestException('Source and destination must be distinct');
    const amount = parsePositiveMoney(body.amount);
    try {
      await this.accounts.getOwnedAccount(fromId, actor);
    } catch (error) {
      if (error instanceof NotFoundException) return this.deny(actor, fromId, correlationId);
      throw error;
    }
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          method: 'POST',
          path: '/v1/transfers',
          body: { amount: formatMoney(amount), fromAccountId: fromId, toAccountId: toId },
        }),
      )
      .digest('hex');
    try {
      const outcome = await this.tx.run(async manager => {
        const keys: { idem_key: string }[] = await manager.query(
          `INSERT INTO idempotency_keys(user_id,idem_key,request_hash) VALUES($1,$2,$3)
           ON CONFLICT(user_id,idem_key) DO NOTHING RETURNING idem_key`,
          [actor, key, hash],
        );
        // The week-2 barrier prevents duplicate writes. Stored-result replay belongs to DBS-79.
        if (!keys.length) throw new ConflictException('Idempotency key already used');
        // The funding account (ADR-09) is the only SYSTEM account and has a fixed, guessable id. A
        // customer may name it as destination, so never lock it here: that would queue behind every
        // deposit, which holds this row for its whole transaction, and end in a 503 instead of the
        // 422 this destination always gets. If another SYSTEM account is ever added, extend this check.
        const lockIds = toId === FUNDING_ACCOUNT_ID ? [fromId] : [fromId, toId];
        const locked = await this.accounts.lockForUpdate(lockIds, manager);
        const source = locked.find(a => a.id === fromId),
          target = locked.find(a => a.id === toId);
        // Authorization reads never supply the money snapshot; check ownership again under lock.
        if (
          !source ||
          source.type === 'SYSTEM' ||
          source.customerId === null ||
          source.userId !== actor
        )
          throw new SourceOwnershipChangedError();
        const customerTarget =
          target && target.type !== 'SYSTEM' && target.customerId !== null && target.userId !== null
            ? target
            : undefined;
        const fromBefore = parseBalance(source.balance);
        const reason =
          source.status !== 'ACTIVE' || !customerTarget || customerTarget.status !== 'ACTIVE'
            ? ErrorCode.ACCOUNT_NOT_ACTIVE
            : fromBefore < amount
              ? ErrorCode.INSUFFICIENT_FUNDS
              : undefined;
        // Overflow is a capacity/invariant error, never a business rejection after a failed SQL write.
        const fromAfter = reason ? undefined : debitBalance(fromBefore, amount);
        const toAfter = reason
          ? undefined
          : creditBalance(parseBalance(customerTarget!.balance), amount);
        const [transfer]: TransferRow[] = await manager.query(
          `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,reject_reason,initiated_by,correlation_id)
           VALUES('TRANSFER',$1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at`,
          [
            fromId,
            customerTarget?.id ?? null,
            formatMoney(amount),
            reason ? 'REJECTED' : 'COMPLETED',
            reason ?? null,
            actor,
            correlationId,
          ],
        );
        if (!reason && customerTarget && fromAfter !== undefined && toAfter !== undefined) {
          await manager.query(
            `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after)
             VALUES($1,$2,'DEBIT',$4,$5),($1,$3,'CREDIT',$4,$6)`,
            [
              transfer.id,
              fromId,
              customerTarget.id,
              formatMoney(amount),
              formatBalance(fromAfter),
              formatBalance(toAfter),
            ],
          );
          await this.accounts.applyBalanceChange(fromId, 0n - amount, manager);
          await this.accounts.applyBalanceChange(customerTarget.id, amount, manager);
        }
        await this.audit.record(manager, {
          actor,
          role: 'customer',
          action: 'transfer',
          outcome: reason ? 'REJECTED' : 'SUCCESS',
          target: { type: 'transfer', id: transfer.id },
          correlationId,
          metadata: reason ? { id: toId, reason } : { id: toId },
        });
        if (!reason && customerTarget) {
          const event: TransferCompleted = {
            eventId: randomUUID(),
            eventType: 'TransferCompleted',
            occurredAt: transfer.created_at.toISOString(),
            correlationId,
            transferId: transfer.id,
            type: 'TRANSFER',
            fromAccountId: fromId,
            toAccountId: customerTarget.id,
            amount: formatMoney(amount),
            fromBalanceBefore: formatBalance(fromBefore),
            fromAccountCreatedAt: source.createdAt.toISOString(),
            toAccountCreatedAt: customerTarget.createdAt.toISOString(),
            fromUserId: source.userId,
            toUserId: customerTarget.userId!,
            sameOwner: source.userId === customerTarget.userId,
          };
          await this.outbox.add(manager, event);
        }
        const result = reason
          ? { errorCode: reason, transferId: transfer.id, message: 'Transfer rejected' }
          : { transferId: transfer.id, status: 'COMPLETED' as const };
        await manager.query(
          'UPDATE idempotency_keys SET transfer_id=$3,response_code=$4,response_body=$5::jsonb WHERE user_id=$1 AND idem_key=$2',
          [actor, key, transfer.id, reason ? 422 : 201, JSON.stringify(result)],
        );
        return { reason, result };
      });
      // Business rejection must commit its transfer, audit and key before the HTTP exception.
      if (outcome.reason) throw new UnprocessableEntityException(outcome.result);
      return outcome.result as TransferResultDto;
    } catch (error) {
      // Never open a second transaction from inside TransactionService's retryable callback.
      if (error instanceof SourceOwnershipChangedError)
        return this.deny(actor, fromId, correlationId);
      throw error;
    }
  }

  private async deny(actor: string, sourceId: string, correlationId: string): Promise<never> {
    await this.audit.recordDenied({
      actor,
      role: 'customer',
      action: 'transfer',
      target: { type: 'account', id: sourceId },
      correlationId,
      metadata: { reason: AuditReason.NOT_OWNER },
    });
    throw new NotFoundException('Account not found');
  }
}
