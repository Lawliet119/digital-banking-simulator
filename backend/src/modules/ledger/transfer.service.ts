import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { limitsConfig } from '@config/limits.config';
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
import {
  FUNDING_ACCOUNT_ID,
  LedgerPostingService,
  type StoredResponse,
} from './ledger-posting.service';

class SourceOwnershipChangedError extends Error {}

type Outcome =
  | { kind: 'replay'; stored: StoredResponse }
  | { kind: 'done'; reason: ErrorCode | undefined; result: Record<string, unknown> };

/**
 * What the source account has already sent today, in Vietnam time (BR-06). The day starts at
 * 00:00 Asia/Ho_Chi_Minh and the clock is read per statement, so a request that waited on the
 * account lock does not use a day boundary that is already past. Debit lines of a customer
 * account only come from its own transfers, never from deposits.
 */
const SENT_TODAY_SQL = `SELECT coalesce(sum(amount),0)::text AS total FROM ledger_entries
  WHERE account_id=$1 AND direction='DEBIT'
    AND created_at >= date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')
                      AT TIME ZONE 'Asia/Ho_Chi_Minh'`;

@Injectable()
export class TransferService {
  constructor(
    private readonly tx: TransactionService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxWriter,
    private readonly posting: LedgerPostingService,
    @Inject(limitsConfig.KEY) private readonly limits: ConfigType<typeof limitsConfig>,
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
    const hash = this.posting.hashRequest('/v1/transfers', {
      amount: formatMoney(amount),
      fromAccountId: fromId,
      toAccountId: toId,
    });
    try {
      const outcome = await this.tx.run<Outcome>(async manager => {
        const stored = await this.posting.claimKey(manager, actor, key, hash);
        if (stored) return { kind: 'replay', stored };
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
        const reason = await this.refusal(manager, source, customerTarget, fromBefore, amount);
        // Overflow is a capacity/invariant error, never a business rejection after a failed SQL write.
        const fromAfter = reason ? undefined : debitBalance(fromBefore, amount);
        const toAfter = reason
          ? undefined
          : creditBalance(parseBalance(customerTarget!.balance), amount);
        const transfer = await this.posting.insertTransfer(manager, {
          type: 'TRANSFER',
          fromAccountId: fromId,
          toAccountId: customerTarget?.id ?? null,
          amount,
          rejectReason: reason ?? null,
          actor,
          correlationId,
        });
        if (!reason && customerTarget && fromAfter !== undefined && toAfter !== undefined) {
          await this.posting.postDoubleEntry(manager, {
            transferId: transfer.id,
            debitAccountId: fromId,
            creditAccountId: customerTarget.id,
            amount,
            debitBalanceAfter: fromAfter,
            creditBalanceAfter: toAfter,
          });
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
        const result: Record<string, unknown> = reason
          ? { errorCode: reason, transferId: transfer.id, message: 'Transfer rejected' }
          : { transferId: transfer.id, status: 'COMPLETED' as const };
        await this.posting.storeResult(manager, actor, key, transfer.id, {
          code: reason ? 422 : 201,
          body: result,
        });
        return { kind: 'done', reason, result };
      });
      // Business rejection must commit its transfer, audit and key before the HTTP exception.
      if (outcome.kind === 'replay') return this.posting.replay<TransferResultDto>(outcome.stored);
      if (outcome.reason) throw new UnprocessableEntityException(outcome.result);
      return outcome.result as unknown as TransferResultDto;
    } catch (error) {
      // Never open a second transaction from inside TransactionService's retryable callback.
      if (error instanceof SourceOwnershipChangedError)
        return this.deny(actor, fromId, correlationId);
      throw error;
    }
  }

  /**
   * The synchronous guard (docs/03 §6.1, §15.1), run on the locked rows: accounts ACTIVE, enough
   * money, then the per-transfer and per-day limits. It sits after FOR UPDATE on purpose: the day
   * total is only trustworthy while no other transfer from this account can commit (AC-5.6).
   */
  private async refusal(
    manager: EntityManager,
    source: { id: string; status: string },
    target: { status: string } | undefined,
    fromBefore: bigint,
    amount: bigint,
  ): Promise<ErrorCode | undefined> {
    if (source.status !== 'ACTIVE' || !target || target.status !== 'ACTIVE') {
      return ErrorCode.ACCOUNT_NOT_ACTIVE;
    }
    if (fromBefore < amount) return ErrorCode.INSUFFICIENT_FUNDS;
    if (amount > this.limits.transfer.perTx) return ErrorCode.LIMIT_PER_TX_EXCEEDED;
    const [{ total }]: { total: string }[] = await manager.query(SENT_TODAY_SQL, [source.id]);
    if (BigInt(total) + amount > this.limits.transfer.perDay) {
      return ErrorCode.LIMIT_PER_DAY_EXCEEDED;
    }
    return undefined;
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
