import { randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';

/**
 * SQL INPUT for the midnight tests (DBS-85): a COMPLETED transfer whose two ledger lines carry a
 * chosen `created_at`. `ledger_entries` is append-only, so a line in the past can only be inserted,
 * never moved. The pair and the balances are kept consistent, so the ledger invariants still pass.
 * Only for a disposable `dbs_test_*` database; the sender must already hold the money (deposit API).
 */
export async function postBackdatedTransfer(
  runner: QueryRunner,
  input: { from: string; to: string; amount: string; at: string; actorId: string },
): Promise<string> {
  const [{ name }] = await runner.query('SELECT current_database() AS name');
  if (!/^dbs_test_[0-9a-f]{12}$/.test(name))
    throw new Error('Backdating needs a dbs_test database');
  await runner.startTransaction();
  try {
    const [from] = await runner.query(
      'WITH c AS (UPDATE accounts SET balance = balance - $2::bigint WHERE id = $1 RETURNING balance) SELECT balance::text AS balance FROM c',
      [input.from, input.amount],
    );
    const [to] = await runner.query(
      'WITH c AS (UPDATE accounts SET balance = balance + $2::bigint WHERE id = $1 RETURNING balance) SELECT balance::text AS balance FROM c',
      [input.to, input.amount],
    );
    const [transfer] = await runner.query(
      `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id,created_at)
       VALUES('TRANSFER',$1,$2,$3,'COMPLETED',$4,$5,$6::timestamptz) RETURNING id`,
      [input.from, input.to, input.amount, input.actorId, randomUUID(), input.at],
    );
    await runner.query(
      `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after,created_at)
       VALUES($1,$2,'DEBIT',$3,$4,$7::timestamptz),($1,$5,'CREDIT',$3,$6,$7::timestamptz)`,
      [transfer.id, input.from, input.amount, from.balance, input.to, to.balance, input.at],
    );
    await runner.commitTransaction();
    return transfer.id as string;
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  }
}
