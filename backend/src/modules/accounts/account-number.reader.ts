import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Reads the customer-facing account number of account ids, on the caller's transaction. The
 * `ledger` module shows numbers beside the UUIDs it already returns; it asks here instead of
 * joining `accounts` itself, so the table stays behind this module. Read only: it takes no row
 * lock and changes nothing, so it is not on the money path.
 */
@Injectable()
export class AccountNumberReader {
  /** Ids with no account are left out of the map. `ids` are UUIDs the caller already validated. */
  async numbersOf(manager: EntityManager, ids: readonly string[]): Promise<Map<string, string>> {
    const distinct = [...new Set(ids)];
    if (distinct.length === 0) return new Map();
    const rows: { id: string; accountNumber: string }[] = await manager.query(
      'SELECT id, account_number AS "accountNumber" FROM accounts WHERE id = ANY($1::uuid[])',
      [distinct],
    );
    return new Map(rows.map(row => [row.id, row.accountNumber]));
  }
}
