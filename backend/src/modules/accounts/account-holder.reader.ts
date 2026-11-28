import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export interface AccountHolder {
  accountNumber: string;
  /** The customer's full name; `null` for the SYSTEM account, which has no customer. */
  ownerName: string | null;
}

/**
 * Number and owner name of account ids, on the caller's transaction, for screens that name the
 * other side of a transfer. Callers decide whether the reader may see them: only show the
 * counterparty of a movement on the reader's own account. Read only, no row lock.
 */
@Injectable()
export class AccountHolderReader {
  /** Ids with no account are left out of the map. `ids` are UUIDs read from the database. */
  async holdersOf(
    manager: EntityManager,
    ids: readonly string[],
  ): Promise<Map<string, AccountHolder>> {
    const distinct = [...new Set(ids)];
    if (distinct.length === 0) return new Map();
    const rows: (AccountHolder & { id: string })[] = await manager.query(
      `SELECT a.id, a.account_number AS "accountNumber", c.full_name AS "ownerName"
       FROM accounts a LEFT JOIN customers c ON c.id = a.customer_id
       WHERE a.id = ANY($1::uuid[])`,
      [distinct],
    );
    return new Map(
      rows.map(row => [row.id, { accountNumber: row.accountNumber, ownerName: row.ownerName }]),
    );
  }
}
