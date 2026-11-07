import { createHash } from 'node:crypto';
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { AccountsService } from '@modules/accounts';
import { ErrorCode } from '@common/errors/error-code.enum';
import { type Balance, formatBalance, formatMoney, type Money } from '@common/money';

/** The single SYSTEM account that funds deposits (ADR-09). Seeded by the first migration. */
export const FUNDING_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

export interface TransferRow {
  id: string;
  created_at: Date;
}

/** What a request with this key answered the first time, as stored by `storeResult`. */
export interface StoredResponse {
  code: number;
  body: Record<string, unknown>;
}

interface StoredKeyRow {
  request_hash: string;
  response_code: number | null;
  response_body: Record<string, unknown> | null;
}

/** Same value with object keys in code-unit order at every depth; array order is data and is kept. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => [key, sortKeys(inner)]),
  );
}

/**
 * The part of a money movement that is the same for every kind of transfer: claiming the
 * Idempotency-Key, writing the transfer row, the two ledger lines and the two balance changes,
 * and storing the answer under the key. A use case (deposit, customer transfer) decides WHO may
 * move money and WHEN it is refused; this class only does the writing, always through the caller's
 * transaction `manager` (BR-02: one transaction, nothing here opens its own).
 */
@Injectable()
export class LedgerPostingService {
  constructor(private readonly accounts: AccountsService) {}

  /**
   * sha256 of the request as the client sent it, so the same key with another body is detectable.
   * Keys are sorted at every level (ADR-05): the hash must not depend on the order in which a
   * caller happened to write them, or a harmless refactor would turn every stored key into
   * IDEMPOTENCY_KEY_REUSED. Bodies written in alphabetical order keep the hash they already had.
   * Amounts stay strings; a number would merge 9007199254740992 and 9007199254740993.
   */
  hashRequest(path: string, body: Record<string, string>): string {
    return createHash('sha256')
      .update(JSON.stringify({ method: 'POST', path, body: sortKeys(body) }))
      .digest('hex');
  }

  /**
   * Reserves `(actor, key)` for this transaction. Returns `undefined` when the key is new.
   *
   * When the key already exists the INSERT inserts nothing: at READ COMMITTED a concurrent request
   * still holding the same key makes this statement wait until that transaction commits (the next
   * SELECT then sees its stored answer) or rolls back (this INSERT then succeeds as a new request).
   * Same request again returns the stored answer; a different request under the same key is
   * refused with IDEMPOTENCY_KEY_REUSED (BR-07, ADR-05).
   */
  async claimKey(
    manager: EntityManager,
    actor: string,
    key: string,
    hash: string,
  ): Promise<StoredResponse | undefined> {
    const claimed: { idem_key: string }[] = await manager.query(
      `INSERT INTO idempotency_keys(user_id,idem_key,request_hash) VALUES($1,$2,$3)
       ON CONFLICT(user_id,idem_key) DO NOTHING RETURNING idem_key`,
      [actor, key, hash],
    );
    if (claimed.length > 0) return undefined;
    const [stored]: StoredKeyRow[] = await manager.query(
      'SELECT request_hash,response_code,response_body FROM idempotency_keys WHERE user_id=$1 AND idem_key=$2',
      [actor, key],
    );
    // Only the retention job can delete a key, and it keeps them for days: this is not a client error.
    if (!stored) throw new Error('Idempotency key disappeared while being replayed');
    if (stored.request_hash !== hash) {
      throw new UnprocessableEntityException({
        errorCode: ErrorCode.IDEMPOTENCY_KEY_REUSED,
        message: 'Idempotency-Key was already used with a different request',
      });
    }
    // The key and its answer are written in one transaction, so a visible key always has one.
    if (stored.response_code === null || stored.response_body === null) {
      throw new Error('Idempotency key has no stored result');
    }
    return { code: stored.response_code, body: stored.response_body };
  }

  /** Gives the client the same answer as the first time: 201 with the body, or the same 422. */
  replay<T>(stored: StoredResponse): T {
    if (stored.code === 201) return stored.body as T;
    if (stored.code === 422) throw new UnprocessableEntityException(stored.body);
    throw new Error(`Unexpected stored response code ${stored.code}`);
  }

  async insertTransfer(
    manager: EntityManager,
    transfer: {
      type: 'TRANSFER' | 'DEPOSIT';
      fromAccountId: string;
      toAccountId: string | null;
      amount: Money;
      rejectReason: string | null;
      actor: string;
      correlationId: string;
    },
  ): Promise<TransferRow> {
    const [row]: TransferRow[] = await manager.query(
      `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,reject_reason,initiated_by,correlation_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,created_at`,
      [
        transfer.type,
        transfer.fromAccountId,
        transfer.toAccountId,
        formatMoney(transfer.amount),
        transfer.rejectReason ? 'REJECTED' : 'COMPLETED',
        transfer.rejectReason,
        transfer.actor,
        transfer.correlationId,
      ],
    );
    return row;
  }

  /** Debit and credit lines plus both balance changes. Both accounts must already be locked. */
  async postDoubleEntry(
    manager: EntityManager,
    entry: {
      transferId: string;
      debitAccountId: string;
      creditAccountId: string;
      amount: Money;
      debitBalanceAfter: Balance;
      creditBalanceAfter: Balance;
    },
  ): Promise<void> {
    await manager.query(
      `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after)
       VALUES($1,$2,'DEBIT',$4,$5),($1,$3,'CREDIT',$4,$6)`,
      [
        entry.transferId,
        entry.debitAccountId,
        entry.creditAccountId,
        formatMoney(entry.amount),
        formatBalance(entry.debitBalanceAfter),
        formatBalance(entry.creditBalanceAfter),
      ],
    );
    await this.accounts.applyBalanceChange(entry.debitAccountId, 0n - entry.amount, manager);
    await this.accounts.applyBalanceChange(entry.creditAccountId, entry.amount, manager);
  }

  async storeResult(
    manager: EntityManager,
    actor: string,
    key: string,
    transferId: string,
    response: StoredResponse,
  ): Promise<void> {
    await manager.query(
      'UPDATE idempotency_keys SET transfer_id=$3,response_code=$4,response_body=$5::jsonb WHERE user_id=$1 AND idem_key=$2',
      [actor, key, transferId, response.code, JSON.stringify(response.body)],
    );
  }
}
