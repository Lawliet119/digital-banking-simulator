import type { QueryRunner } from 'typeorm';
import { assertInvariantFixtureDatabase, seedInvariantAccounts } from './invariant-fixtures';

export interface DailyDebitLedgerSpec {
  /** DEBIT lines of the one hot account, spread evenly over `spanDays` before now. */
  hotRows: number;
  /** DEBIT and CREDIT lines of the other accounts, spread the same way. */
  noiseRows: number;
  noiseAccounts: number;
  /** Lines of the hot account written in the last second, so "today" is never empty. */
  todayRows: number;
  spanDays: number;
}

/**
 * Loads a ledger shaped like a busy bank: one hot account with `hotRows` debits over two years,
 * and `noiseRows` lines spread over many other accounts. Set-based SQL, one transaction. It is
 * the data for the EXPLAIN checks of the daily-limit query (DBS-84) and bypasses the deposit API
 * on purpose, only in a disposable `dbs_test_*` database (the fixture asserts it). Only the DEBIT
 * side exists for the hot account, so the ledger invariants do not hold on this data.
 */
export async function loadDailyDebitLedger(
  runner: QueryRunner,
  spec: DailyDebitLedgerSpec,
): Promise<{ hotAccountId: string; actorId: string }> {
  await assertInvariantFixtureDatabase(runner);
  const refs = await seedInvariantAccounts(runner);
  // Accounts for the noise: one user, customer and account each (SQL INPUT).
  await runner.query(
    `INSERT INTO users(cognito_sub) SELECT 'noise-' || g FROM generate_series(1,$1::int) g`,
    [spec.noiseAccounts],
  );
  await runner.query(
    `INSERT INTO customers(user_id,full_name)
     SELECT id, 'Khách ' || cognito_sub FROM users WHERE cognito_sub LIKE 'noise-%'`,
  );
  await runner.query(
    `INSERT INTO accounts(customer_id,type,status)
     SELECT id,'CHECKING','ACTIVE' FROM customers WHERE full_name LIKE 'Khách noise-%'`,
  );
  const spanSeconds = spec.spanDays * 86_400;
  // A transfer per line (the ledger foreign key needs one), then the DEBIT line of its source.
  await runner.query(
    `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id,created_at)
     SELECT 'TRANSFER', $1::uuid, $2::uuid, 1000 + (g % 500), 'COMPLETED', $3::uuid, gen_random_uuid(),
            clock_timestamp() - (g * ($4::numeric / $5::numeric)) * interval '1 second'
     FROM generate_series(1,$5::int) g`,
    [refs.senderId, refs.recipientId, refs.actorId, spanSeconds, spec.hotRows],
  );
  await runner.query(
    `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id,created_at)
     SELECT 'TRANSFER', a.id, $2::uuid, 5000, 'COMPLETED', $3::uuid, gen_random_uuid(),
            clock_timestamp() - (g * ($4::numeric / $5::numeric)) * interval '1 second'
     FROM generate_series(1,$5::int) g
     JOIN (SELECT id, row_number() OVER (ORDER BY id) AS n FROM accounts
           WHERE id NOT IN ($1::uuid,$2::uuid,$6::uuid)) a ON a.n = 1 + (g % $7::int)`,
    [
      refs.senderId,
      refs.recipientId,
      refs.actorId,
      spanSeconds,
      spec.noiseRows,
      refs.unusedId,
      spec.noiseAccounts,
    ],
  );
  await runner.query(
    `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id,created_at)
     SELECT 'TRANSFER', $1::uuid, $2::uuid, 15000000, 'COMPLETED', $3::uuid, gen_random_uuid(),
            clock_timestamp() - g * interval '1 millisecond'
     FROM generate_series(1,$4::int) g`,
    [refs.senderId, refs.recipientId, refs.actorId, spec.todayRows],
  );
  await runner.query(
    `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after,created_at)
     SELECT t.id, t.from_account_id, 'DEBIT', t.amount, 0, t.created_at FROM transfers t
     WHERE t.status = 'COMPLETED'
       AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transfer_id = t.id)`,
  );
  return { hotAccountId: refs.senderId, actorId: refs.actorId };
}

/** Every node of an `EXPLAIN (FORMAT JSON)` plan, parents before children. */
export function planNodes(plan: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (node: Record<string, unknown>) => {
    out.push(node);
    for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
  };
  walk((plan as { Plan: Record<string, unknown> }).Plan);
  return out;
}
