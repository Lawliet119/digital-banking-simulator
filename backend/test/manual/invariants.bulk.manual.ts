import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  INVARIANT_FUNDING_ID,
  assertInvariantFixtureDatabase,
  seedInvariantAccounts,
} from '../support/invariant-fixtures';
import { createTempDatabase, migrate, requireDatabaseUrl } from '../support/temp-database';

/**
 * DBS-69 R-7: opt-in timing of the invariant SQL on a large ledger. NOT part of manual-test.txt:
 * the number depends on the machine and must not slow down every final-SHA run.
 *
 *   DBS69_BULK_ROWS=1000000 DATABASE_URL=… npx ts-node -r tsconfig-paths/register \
 *     test/manual/invariants.bulk.manual.ts
 *
 * It needs an existing PostgreSQL server (DATABASE_URL). It builds its own disposable `dbs_test_*`
 * database, loads balanced COMPLETED transfers with set-based SQL, times the real CLI and drops the
 * database in `finally`. The invariant SQL itself is not changed by this script.
 */
const MAX_ROWS = 2_000_000;
const backend = resolve(__dirname, '../..');

async function main() {
  const requested = process.env.DBS69_BULK_ROWS;
  if (!requested) {
    console.log('DBS69_BULK_ROWS is not set: nothing to do (this step is opt-in).');
    return;
  }
  const rows = Number(requested);
  assert(
    Number.isInteger(rows) && rows >= 2 && rows % 2 === 0,
    'DBS69_BULK_ROWS must be an even integer >= 2',
  );
  assert(rows <= MAX_ROWS, `DBS69_BULK_ROWS is capped at ${MAX_ROWS} ledger entries`);
  // Fails with a clear message when no server is configured; createTempDatabase reads it too.
  requireDatabaseUrl();
  const transfers = rows / 2;

  const db = await createTempDatabase();
  let failed: unknown;
  try {
    await migrate(db.url);
    await db.runner.startTransaction();
    await assertInvariantFixtureDatabase(db.runner);
    const refs = await seedInvariantAccounts(db.runner);

    console.log(`loading ${transfers} COMPLETED transfers (${rows} ledger entries) in ${db.name}`);
    const loadStart = performance.now();
    // Customer sender -> recipient transfers of 1 dong, funded once from the SYSTEM account, so
    // every balance matches its entries, the total is 0 and no customer goes negative.
    await db.runner.query(
      `INSERT INTO transfers(id,type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id)
       SELECT gen_random_uuid(),'TRANSFER',$1::uuid,$2::uuid,1,'COMPLETED',$3::uuid,gen_random_uuid()
       FROM generate_series(1,$4::int)`,
      [refs.senderId, refs.recipientId, refs.actorId, transfers],
    );
    await db.runner.query(
      `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after)
       SELECT t.id, t.from_account_id, 'DEBIT', 1, 0 FROM transfers t
       UNION ALL
       SELECT t.id, t.to_account_id, 'CREDIT', 1, 0 FROM transfers t`,
    );
    // Balances follow the entries: sender -transfers, recipient +transfers. The sender is a customer
    // account and may not go negative, so it is first funded by the SYSTEM account in one transfer.
    await db.runner.query(
      `WITH deposit AS (
         INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id)
         VALUES('DEPOSIT',$1::uuid,$2::uuid,$3::bigint,'COMPLETED',$4::uuid,gen_random_uuid()) RETURNING id
       ), debit AS (
         INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after)
         SELECT id,$1::uuid,'DEBIT',$3::bigint,0 FROM deposit
       ), credit AS (
         INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after)
         SELECT id,$2::uuid,'CREDIT',$3::bigint,0 FROM deposit
       ) SELECT 1`,
      [INVARIANT_FUNDING_ID, refs.senderId, transfers, refs.actorId],
    );
    await db.runner.query(
      `UPDATE accounts SET balance = COALESCE((
         SELECT SUM(CASE WHEN e.direction='CREDIT' THEN e.amount ELSE -e.amount END)
         FROM ledger_entries e WHERE e.account_id = accounts.id), 0)`,
    );
    await db.runner.commitTransaction();
    const loadMs = performance.now() - loadStart;
    const [{ n }] = await db.runner.query('SELECT count(*)::text AS n FROM ledger_entries');
    console.log(`loaded ${n} ledger entries in ${(loadMs / 1000).toFixed(1)} s`);

    const start = process.hrtime.bigint();
    const result = spawnSync(
      process.execPath,
      [
        '-r',
        require.resolve('ts-node/register'),
        '-r',
        require.resolve('tsconfig-paths/register'),
        resolve(backend, 'test/support/invariants.ts'),
      ],
      {
        cwd: backend,
        env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: db.url, DATABASE_SSL: 'false' },
        encoding: 'utf8',
        timeout: 180_000,
      },
    );
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const out = result.stdout.trim();
    const err = result.stderr.trim();
    // Recorded whether it passes or times out (ERROR 57014 at the CLI's 60 s statement timeout).
    console.log(
      JSON.stringify({
        ledgerEntries: Number(n),
        cliSeconds: Number(seconds.toFixed(2)),
        exit: result.status,
        status: out ? (JSON.parse(out) as { status: string }).status : null,
        error: err ? JSON.parse(err) : null,
      }),
    );
  } catch (error) {
    failed = error;
    throw error;
  } finally {
    try {
      if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
    } finally {
      await db.drop();
      console.log('DROPPED TEMP DATABASE', db.name);
    }
    if (failed) process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error('DBS-69 bulk timing failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
