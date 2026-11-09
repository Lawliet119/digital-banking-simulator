// DBS-117 manual test: worker reconciliation job (4 invariant checks, reconciliation_runs persistence,
// BL-165 signed bigint overflow -> ERROR, advisory lock, dbs_worker least-privilege, 100k-row benchmark).
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
process.chdir(resolve(__dirname, '..'));
const { DataSource } = require('typeorm');
const { runManual } = require('./lib/ledger-manual-harness.cjs');
const { SystemClock } = require('../src/common/clock');
const { TransactionService } = require('../src/database/transaction.service');
const {
  RECONCILIATION_ADVISORY_LOCK_KEY,
  RECONCILIATION_CHECK_SQL,
  ReconciliationService,
} = require('../src/modules/ledger');

const FUNDING_ID = '00000000-0000-4000-8000-000000000001';

runManual('DBS-117', async ctx => {
  const { q, db, app, transfer, target, invariant, assert, pass, randomUUID } = ctx;

  const tx = app.app.get(TransactionService);
  const service = new ReconciliationService(tx, new SystemClock(), {
    transfer: { perTx: 50_000_000n, perDay: 200_000_000n },
    idempotencyKeyRetentionDays: 7,
    rateLimit: { transfersPerMinute: 10, requestsPerIpPerMinute: 100 },
    reconciliationIntervalMs: 300_000,
  });

  // M-117-01: Clean ledger after operator deposit (5,000,000) and transfer (1,500,000) -> status = OK
  const minhAnh = await target('5000000');
  const thuHa = await target('0');
  await q('UPDATE public.customers SET full_name = $2 WHERE id = $1', [
    thuHa.customerId,
    'Trần Thu Hà',
  ]);
  const transferRes = await transfer(minhAnh, thuHa.accountId, '1500000');
  assert.equal(transferRes.status, 201);

  const run1 = await service.reconcileOnce();
  console.log(JSON.stringify({ step: 'M-117-01', run1 }));
  assert.equal(run1.executed, true);
  assert.equal(run1.status, 'OK');
  assert.equal(run1.totalDebit, '6500000');
  assert.equal(run1.totalCredit, '6500000');
  assert.equal(run1.totalBalance, '0');
  assert.equal(run1.mismatchedAccounts, 0);
  assert.deepEqual(run1.details, []);
  pass(
    'M-117-01',
    'Minh Anh funded 5,000,000 and sent 1,500,000 to Trần Thu Hà; reconcileOnce() recorded status = OK (totalDebit = totalCredit = 6,500,000, totalBalance = 0)',
  );

  // M-117-02: Corrupt Minh Anh balance (+100,000) -> MISMATCH (no PII in details), then restore -> OK
  await q('UPDATE public.accounts SET balance = 3600000 WHERE id = $1', [minhAnh.accountId]);
  const run2Mismatch = await service.reconcileOnce();
  console.log(JSON.stringify({ step: 'M-117-02-mismatch', run2Mismatch }));
  assert.equal(run2Mismatch.executed, true);
  assert.equal(run2Mismatch.status, 'MISMATCH');
  assert.equal(run2Mismatch.totalBalance, '100000');
  assert.equal(run2Mismatch.mismatchedAccounts, 1);
  assert.deepEqual(run2Mismatch.details, [
    {
      accountId: minhAnh.accountId,
      balance: '3600000',
      ledgerBalance: '3500000',
    },
  ]);

  await q('UPDATE public.accounts SET balance = 3500000 WHERE id = $1', [minhAnh.accountId]);
  const run2Recovered = await service.reconcileOnce();
  console.log(JSON.stringify({ step: 'M-117-02-recovered', run2Recovered }));
  assert.equal(run2Recovered.status, 'OK');
  pass(
    'M-117-02',
    'Corrupted Minh Anh balance (3,600,000 vs ledger 3,500,000) detected as MISMATCH with exact details and zero PII; restored to OK',
  );

  // M-117-03: COMPLETED transfer missing ledger_entries legs -> MISMATCH (Check 4), then repair -> OK
  const [unpairedTx] = await q(
    `INSERT INTO public.transfers (type, from_account_id, to_account_id, amount, status, initiated_by, correlation_id)
     VALUES ('TRANSFER', $1, $2, 200000, 'COMPLETED', $3, $4)
     RETURNING id`,
    [minhAnh.accountId, thuHa.accountId, minhAnh.userId, randomUUID()],
  );
  const run3Mismatch = await service.reconcileOnce();
  console.log(JSON.stringify({ step: 'M-117-03-mismatch', run3Mismatch }));
  assert.equal(run3Mismatch.status, 'MISMATCH');
  assert.equal(run3Mismatch.mismatchedAccounts, 0);
  assert.deepEqual(run3Mismatch.details, []);

  // Repair the unpaired COMPLETED transfer by posting its two legs and updating balances
  await q(
    `INSERT INTO public.ledger_entries (transfer_id, account_id, direction, amount, balance_after)
     VALUES
       ($1, $2, 'DEBIT', 200000, 3300000),
       ($1, $3, 'CREDIT', 200000, 1700000)`,
    [unpairedTx.id, minhAnh.accountId, thuHa.accountId],
  );
  await q('UPDATE public.accounts SET balance = 3300000 WHERE id = $1', [minhAnh.accountId]);
  await q('UPDATE public.accounts SET balance = 1700000 WHERE id = $1', [thuHa.accountId]);
  const run3Repaired = await service.reconcileOnce();
  assert.equal(run3Repaired.status, 'OK');
  pass(
    'M-117-03',
    'Detected COMPLETED transfer missing DEBIT/CREDIT legs as MISMATCH (mismatchedAccounts = 0, details = []); repaired to OK',
  );

  // M-117-04: Cumulative SUM(amount) > max signed 64-bit bigint -> status = ERROR with NULLs (BL-165)
  const hugeAmount = '5000000000000000000'; // 5 * 10^18; 2 transfers sum to 10^19 > 9223372036854775807
  const [hugeTx1] = await q(
    `INSERT INTO public.transfers (type, from_account_id, to_account_id, amount, status, initiated_by, correlation_id)
     VALUES ('DEPOSIT', $1, $2, $3, 'COMPLETED', $4, $5)
     RETURNING id`,
    [FUNDING_ID, minhAnh.accountId, hugeAmount, minhAnh.userId, randomUUID()],
  );
  const [hugeTx2] = await q(
    `INSERT INTO public.transfers (type, from_account_id, to_account_id, amount, status, initiated_by, correlation_id)
     VALUES ('TRANSFER', $1, $2, $3, 'COMPLETED', $4, $5)
     RETURNING id`,
    [minhAnh.accountId, thuHa.accountId, hugeAmount, minhAnh.userId, randomUUID()],
  );
  await q(
    `INSERT INTO public.ledger_entries (transfer_id, account_id, direction, amount, balance_after)
     VALUES
       ($1, $3, 'DEBIT', $6, -5000000000006700000),
       ($1, $4, 'CREDIT', $6, 5000000000003300000),
       ($2, $4, 'DEBIT', $6, 3300000),
       ($2, $5, 'CREDIT', $6, 5000000000001700000)`,
    [hugeTx1.id, hugeTx2.id, FUNDING_ID, minhAnh.accountId, thuHa.accountId, hugeAmount],
  );
  await q('UPDATE public.accounts SET balance = balance - $2::bigint WHERE id = $1', [
    FUNDING_ID,
    hugeAmount,
  ]);
  await q('UPDATE public.accounts SET balance = balance + $2::bigint WHERE id = $1', [
    thuHa.accountId,
    hugeAmount,
  ]);

  const run4Overflow = await service.reconcileOnce();
  console.log(JSON.stringify({ step: 'M-117-04-overflow', run4Overflow }));
  assert.equal(run4Overflow.executed, true);
  assert.equal(run4Overflow.status, 'ERROR');
  assert.equal(run4Overflow.totalDebit, null);
  assert.equal(run4Overflow.totalCredit, null);
  assert.equal(run4Overflow.totalBalance, '0');
  assert.equal(run4Overflow.mismatchedAccounts, 0);
  assert.equal(run4Overflow.details, null);

  // Clean up the 2 overflow fixture transfers in disposable DB so M-117-05..07 run on normal totals
  await q('ALTER TABLE public.ledger_entries DISABLE TRIGGER ledger_entries_append_only');
  await q('ALTER TABLE public.transfers DISABLE TRIGGER transfers_append_only');
  await q('DELETE FROM public.ledger_entries WHERE transfer_id IN ($1, $2)', [
    hugeTx1.id,
    hugeTx2.id,
  ]);
  await q('DELETE FROM public.transfers WHERE id IN ($1, $2)', [hugeTx1.id, hugeTx2.id]);
  await q('ALTER TABLE public.transfers ENABLE TRIGGER transfers_append_only');
  await q('ALTER TABLE public.ledger_entries ENABLE TRIGGER ledger_entries_append_only');
  await q('UPDATE public.accounts SET balance = -5000000 WHERE id = $1', [FUNDING_ID]);
  await q('UPDATE public.accounts SET balance = 1700000 WHERE id = $1', [thuHa.accountId]);
  pass(
    'M-117-04',
    'Cumulative SUM(amount) > 9223372036854775807 classified as status = ERROR with NULL overflowing totals and NULL details (BL-165)',
  );

  // M-117-05: Advisory lock single-instance skip + least-privilege dbs_worker execution
  const lockHolder = app.source.createQueryRunner();
  await lockHolder.connect();
  try {
    await lockHolder.query('SELECT pg_advisory_lock($1, $2)', [
      RECONCILIATION_ADVISORY_LOCK_KEY[0],
      RECONCILIATION_ADVISORY_LOCK_KEY[1],
    ]);
    const skipped = await service.reconcileOnce();
    console.log(JSON.stringify({ step: 'M-117-05-locked', skipped }));
    assert.deepEqual(skipped, { executed: false });
  } finally {
    await lockHolder.query('SELECT pg_advisory_unlock($1, $2)', [
      RECONCILIATION_ADVISORY_LOCK_KEY[0],
      RECONCILIATION_ADVISORY_LOCK_KEY[1],
    ]);
    await lockHolder.release();
  }

  const rolesSql = readFileSync(resolve(__dirname, '../../infra/scripts/db-roles.sql'), 'utf8');
  await q(rolesSql);
  const rolePassword = 'manual-role-pass';
  await q(`ALTER ROLE dbs_worker LOGIN PASSWORD '${rolePassword}'`);
  await q(`ALTER ROLE dbs_api LOGIN PASSWORD '${rolePassword}'`);

  const workerUrl = new URL(db.url);
  workerUrl.username = 'dbs_worker';
  workerUrl.password = rolePassword;
  const workerSource = await new DataSource({
    type: 'postgres',
    url: workerUrl.toString(),
  }).initialize();
  try {
    const workerTx = new TransactionService(workerSource, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    });
    const workerReconciliation = new ReconciliationService(workerTx, new SystemClock(), {
      transfer: { perTx: 50_000_000n, perDay: 200_000_000n },
      idempotencyKeyRetentionDays: 7,
      rateLimit: { transfersPerMinute: 10, requestsPerIpPerMinute: 100 },
      reconciliationIntervalMs: 300_000,
    });
    const workerOutcome = await workerReconciliation.reconcileOnce();
    console.log(JSON.stringify({ step: 'M-117-05-dbs_worker', workerOutcome }));
    assert.equal(workerOutcome.executed, true);
    assert.equal(workerOutcome.status, 'OK');
  } finally {
    await workerSource.destroy();
  }
  pass(
    'M-117-05',
    'Advisory lock (20261108, 117) skipped concurrent run ({ executed: false }); after release, dbs_worker executed reconcileOnce() with least-privilege grants -> status = OK',
  );

  // M-117-06: 100,000 ledger_entries rows benchmark (DoD #4)
  const [{ existingEntries }] = await q(
    'SELECT COUNT(*)::int AS "existingEntries" FROM public.ledger_entries',
  );
  const transfersToSeed = Math.floor((100_000 - existingEntries) / 2);
  await q(
    `WITH inserted_transfers AS (
       INSERT INTO public.transfers (
         id,
         type,
         from_account_id,
         to_account_id,
         amount,
         status,
         initiated_by,
         correlation_id
       )
       SELECT
         gen_random_uuid(),
         'DEPOSIT',
         $1::uuid,
         $2::uuid,
         1000,
         'COMPLETED',
         $3::uuid,
         gen_random_uuid()
       FROM generate_series(1, $4::int)
       RETURNING id, from_account_id, to_account_id, amount
     )
     INSERT INTO public.ledger_entries (
       transfer_id,
       account_id,
       direction,
       amount,
       balance_after
     )
     SELECT
       t.id,
       v.account_id,
       v.direction,
       t.amount,
       0
     FROM inserted_transfers t
     CROSS JOIN LATERAL (
       VALUES
         (t.from_account_id, 'DEBIT'),
         (t.to_account_id, 'CREDIT')
     ) AS v(account_id, direction)`,
    [FUNDING_ID, minhAnh.accountId, minhAnh.userId, transfersToSeed],
  );
  const seededAmount = BigInt(transfersToSeed) * 1000n;
  await q('UPDATE public.accounts SET balance = balance - $2::bigint WHERE id = $1', [
    FUNDING_ID,
    seededAmount.toString(),
  ]);
  await q('UPDATE public.accounts SET balance = balance + $2::bigint WHERE id = $1', [
    minhAnh.accountId,
    seededAmount.toString(),
  ]);
  await q('VACUUM (ANALYZE) public.accounts, public.transfers, public.ledger_entries');

  const [{ totalEntries }] = await q(
    'SELECT COUNT(*)::int AS "totalEntries" FROM public.ledger_entries',
  );
  assert.equal(totalEntries, 100_000);

  const explainRows = await q(`EXPLAIN (ANALYZE, BUFFERS) ${RECONCILIATION_CHECK_SQL}`);
  const explainText = explainRows.map(r => r['QUERY PLAN']).join('\n');
  const explainExecMs = Number(/Execution Time: ([\d.]+) ms/.exec(explainText)?.[1] ?? '0');

  const t0 = performance.now();
  const benchmarkRun = await service.reconcileOnce();
  const durationMs = Math.round(performance.now() - t0);

  console.log(
    JSON.stringify({
      step: 'M-117-06-benchmark-100k',
      totalEntries,
      durationMs,
      explainExecutionTimeMs: explainExecMs,
      status: benchmarkRun.status,
      totalDebit: benchmarkRun.totalDebit,
      totalCredit: benchmarkRun.totalCredit,
      totalBalance: benchmarkRun.totalBalance,
      mismatchedAccounts: benchmarkRun.mismatchedAccounts,
    }),
  );
  assert.equal(benchmarkRun.executed, true);
  assert.equal(benchmarkRun.status, 'OK');
  assert.equal(benchmarkRun.mismatchedAccounts, 0);
  pass(
    'M-117-06',
    `Reconciled 100,000 ledger_entries rows (50,000 COMPLETED transfers) in ${durationMs} ms (SQL Execution Time: ${explainExecMs} ms) -> status = OK`,
  );

  // M-117-07: Verify all persisted reconciliation_runs rows and checkLedgerInvariants
  const allRuns = await q(
    `SELECT id, status, total_debit, total_credit, total_balance, mismatched_accounts, details
     FROM public.reconciliation_runs
     ORDER BY id ASC`,
  );
  console.log(JSON.stringify({ step: 'M-117-07-runs', count: allRuns.length, runs: allRuns }));
  assert.equal(allRuns.length, 8);
  await invariant();
  pass('M-117-07', 'All 8 reconciliation_runs rows verified and checkLedgerInvariants returned PASS');
});
