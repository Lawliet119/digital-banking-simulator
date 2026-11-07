import { randomUUID } from 'node:crypto';
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
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
import {
  FUNDING_ACCOUNT_ID,
  LedgerPostingService,
  type StoredResponse,
} from './ledger-posting.service';

type Outcome =
  | { kind: 'replay'; stored: StoredResponse }
  | { kind: 'done'; rejected: boolean; result: Record<string, unknown> };

@Injectable()
export class DepositService {
  constructor(
    private readonly tx: TransactionService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxWriter,
    private readonly posting: LedgerPostingService,
  ) {}

  async deposit(
    actor: string,
    key: string,
    body: DepositDto,
    correlationId: string,
  ): Promise<DepositResultDto> {
    const amount = parsePositiveMoney(body.amount),
      toId = body.toAccountId.toLowerCase();
    const hash = this.posting.hashRequest('/v1/operator/deposits', {
      amount: formatMoney(amount),
      toAccountId: toId,
    });
    const outcome = await this.tx.run<Outcome>(async manager => {
      const stored = await this.posting.claimKey(manager, actor, key, hash);
      if (stored) return { kind: 'replay', stored };
      const locked = await this.accounts.lockForUpdate([FUNDING_ACCOUNT_ID, toId], manager);
      const funding = locked.find(a => a.id === FUNDING_ACCOUNT_ID),
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
      const transfer = await this.posting.insertTransfer(manager, {
        type: 'DEPOSIT',
        fromAccountId: FUNDING_ACCOUNT_ID,
        toAccountId: customerTarget?.id ?? null,
        amount,
        rejectReason: rejected ? ErrorCode.ACCOUNT_NOT_ACTIVE : null,
        actor,
        correlationId,
      });
      if (!rejected && customerTarget && fromAfter !== undefined && toAfter !== undefined) {
        await this.posting.postDoubleEntry(manager, {
          transferId: transfer.id,
          debitAccountId: FUNDING_ACCOUNT_ID,
          creditAccountId: customerTarget.id,
          amount,
          debitBalanceAfter: fromAfter,
          creditBalanceAfter: toAfter,
        });
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
          fromAccountId: FUNDING_ACCOUNT_ID,
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
      const result: Record<string, unknown> = rejected
        ? {
            errorCode: ErrorCode.ACCOUNT_NOT_ACTIVE,
            transferId: transfer.id,
            message: 'Destination account is not active',
          }
        : { transferId: transfer.id, status: 'COMPLETED' as const };
      await this.posting.storeResult(manager, actor, key, transfer.id, {
        code: rejected ? 422 : 201,
        body: result,
      });
      return { kind: 'done', rejected, result };
    });
    // The rejection, its audit and the key are committed before the 422 leaves.
    if (outcome.kind === 'replay') return this.posting.replay<DepositResultDto>(outcome.stored);
    if (outcome.rejected) throw new UnprocessableEntityException(outcome.result);
    return outcome.result as unknown as DepositResultDto;
  }
}
