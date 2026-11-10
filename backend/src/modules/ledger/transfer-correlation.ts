import type { EntityManager } from 'typeorm';

/**
 * The `correlationId` of the request that created a transfer (`transfers.correlation_id`, set by the
 * server in the same transaction as the ledger entries, DBS-134).
 *
 * Other modules get this value from here instead of reading the `transfers` table: `ledger` owns
 * that table (database-design §3). The fraud review uses it to record its audit line under the
 * code of the transfer, so an auditor traces the whole chain by one code (DBS-135, AC-8.2).
 * Runs on the caller's `manager`, so it joins the caller's transaction. `undefined` when there is
 * no such transfer.
 */
export async function transferCorrelationId(
  manager: EntityManager,
  transferId: string,
): Promise<string | undefined> {
  const rows = await manager.query<{ correlationId: string }[]>(
    `SELECT correlation_id AS "correlationId" FROM transfers WHERE id = $1`,
    [transferId],
  );
  return rows[0]?.correlationId;
}
