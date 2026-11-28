import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export interface LedgerLine {
  /** Whole VND, decimal string. */
  amount: string;
  /** Balance of the account after this line. */
  balanceAfter: string;
}

export const ledgerLineKey = (transferId: string, accountId: string): string =>
  `${transferId}:${accountId}`;

/**
 * The ledger line of (transfer, account) pairs, on the caller's transaction. The caller must
 * already know the account belongs to the reader. Read only.
 */
@Injectable()
export class LedgerLineReader {
  async linesOf(
    manager: EntityManager,
    pairs: readonly { transferId: string; accountId: string }[],
  ): Promise<Map<string, LedgerLine>> {
    if (pairs.length === 0) return new Map();
    const rows: (LedgerLine & { transferId: string; accountId: string })[] = await manager.query(
      `SELECT e.transfer_id AS "transferId", e.account_id AS "accountId",
              e.amount::text AS amount, e.balance_after::text AS "balanceAfter"
       FROM unnest($1::uuid[], $2::uuid[]) AS wanted(transfer_id, account_id)
       JOIN ledger_entries e
         ON e.transfer_id = wanted.transfer_id AND e.account_id = wanted.account_id`,
      [pairs.map(pair => pair.transferId), pairs.map(pair => pair.accountId)],
    );
    return new Map(
      rows.map(row => [
        ledgerLineKey(row.transferId, row.accountId),
        { amount: row.amount, balanceAfter: row.balanceAfter },
      ]),
    );
  }
}
