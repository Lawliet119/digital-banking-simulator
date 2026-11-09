import { parsePositiveMoney } from '@common/money';
import { randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';
import { SystemClock } from '@common/clock';
import { TransactionService } from '@database/transaction.service';
import {
  RECONCILIATION_ADVISORY_LOCK_KEY,
  RECONCILIATION_CHECK_SQL,
  ReconciliationService,
} from '@modules/ledger';
import {
  INVARIANT_FUNDING_ID,
  postInvariantTransfer,
  seedInvariantAccounts,
  seedInvariantLedger,
} from '../support/invariant-fixtures';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

interface ReconciliationRunRow {
  id: string;
  started_at: Date;
  finished_at: Date;
  status: string;
  total_debit: string | null;
  total_credit: string | null;
  total_balance: string | null;
  mismatched_accounts: number;
  details: unknown;
}

describe('DBS-117 worker reconciliation job (real PostgreSQL)', () => {
  let db: TempDatabase;
  let service: ReconciliationService;

  beforeEach(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    const tx = new TransactionService(db.runner.connection, {
      url: db.url,
      poolMax: 10,
      ssl: false,
      sslCaPath: undefined,
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    });
    service = new ReconciliationService(tx, new SystemClock(), {
      transfer: { perTx: parsePositiveMoney('50000000'), perDay: parsePositiveMoney('200000000') },
      idempotencyKeyRetentionDays: 7,
      outbox: { retentionDays: 7, processedEventsRetentionDays: 7 },
      rateLimit: { transfersPerMinute: 10, requestsPerIpPerMinute: 100 },
      reconciliationIntervalMs: 300_000,
    });
  });

  afterEach(async () => {
    if (db?.runner.isTransactionActive) {
      await db.runner.rollbackTransaction();
    }
    await db?.drop();
  });

  async function withCommittedFixture<T>(fn: (runner: QueryRunner) => Promise<T>): Promise<T> {
    await db.runner.startTransaction();
    try {
      const result = await fn(db.runner);
      await db.runner.commitTransaction();
      return result;
    } catch (error) {
      if (db.runner.isTransactionActive) {
        await db.runner.rollbackTransaction();
      }
      throw error;
    }
  }

  async function fetchRuns(): Promise<ReconciliationRunRow[]> {
    return await db.runner.connection.query<ReconciliationRunRow[]>(
      `SELECT id, started_at, finished_at, status, total_debit, total_credit, total_balance, mismatched_accounts, details
       FROM public.reconciliation_runs
       ORDER BY id ASC`,
    );
  }

  async function dropLedgerCompositeFks(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE public.ledger_entries
        DROP CONSTRAINT ledger_entries_transfer_debit_fkey,
        DROP CONSTRAINT ledger_entries_transfer_credit_fkey
    `);
  }

  it('TC-117-02 records status = OK on an empty ledger and after valid deposits + transfers + rejected transfers', async () => {
    const emptyRun = await service.reconcileOnce();
    expect(emptyRun).toMatchObject({
      executed: true,
      status: 'OK',
      totalDebit: '0',
      totalCredit: '0',
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: [],
    });

    await withCommittedFixture(async runner => {
      await seedInvariantLedger(runner);
    });

    const populatedRun = await service.reconcileOnce();
    expect(populatedRun).toMatchObject({
      executed: true,
      status: 'OK',
      totalDebit: '1250000',
      totalCredit: '1250000',
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: [],
    });

    const rows = await fetchRuns();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      status: 'OK',
      total_debit: '0',
      total_credit: '0',
      total_balance: '0',
      mismatched_accounts: 0,
      details: [],
    });
    expect(rows[1]).toMatchObject({
      status: 'OK',
      total_debit: '1250000',
      total_credit: '1250000',
      total_balance: '0',
      mismatched_accounts: 0,
      details: [],
    });
    expect(rows[1].started_at.getTime()).toBeLessThanOrEqual(rows[1].finished_at.getTime());
  });

  it('TC-117-03 detects per-account balance mismatch (including amounts > 2^53) with no PII and recovers to OK when fixed', async () => {
    const refs = await withCommittedFixture(async runner => seedInvariantLedger(runner));
    const aboveSafeInt = '9007199254740993'; // 2^53 + 1

    await db.runner.connection.query(
      'UPDATE public.accounts SET balance = $2::bigint WHERE id = $1',
      [refs.senderId, aboveSafeInt],
    );
    await db.runner.connection.query(
      'UPDATE public.accounts SET balance = $2::bigint WHERE id = $1',
      [INVARIANT_FUNDING_ID, '-900000'],
    );

    const mismatch = await service.reconcileOnce();
    expect(mismatch).toMatchObject({
      executed: true,
      status: 'MISMATCH',
      totalDebit: '1250000',
      totalCredit: '1250000',
      mismatchedAccounts: 2,
    });
    if (!mismatch.executed || mismatch.details === null) {
      throw new Error('Expected executed mismatch with details');
    }
    expect(mismatch.details).toEqual([
      {
        accountId: INVARIANT_FUNDING_ID,
        balance: '-900000',
        ledgerBalance: '-1000000',
      },
      {
        accountId: refs.senderId,
        balance: aboveSafeInt,
        ledgerBalance: '750000',
      },
    ]);
    for (const item of mismatch.details) {
      expect(Object.keys(item).sort()).toEqual(['accountId', 'balance', 'ledgerBalance']);
    }

    // Restore exact balances and confirm next run is OK
    await db.runner.connection.query(
      'UPDATE public.accounts SET balance = $2::bigint WHERE id = $1',
      [refs.senderId, '750000'],
    );
    await db.runner.connection.query(
      'UPDATE public.accounts SET balance = $2::bigint WHERE id = $1',
      [INVARIANT_FUNDING_ID, '-1000000'],
    );

    const recovered = await service.reconcileOnce();
    expect(recovered).toMatchObject({
      executed: true,
      status: 'OK',
      mismatchedAccounts: 0,
      details: [],
    });
  });

  it('TC-117-04 detects Check 1 (total DEBIT <> total CREDIT) in isolation when account balances match and sum to 0', async () => {
    await withCommittedFixture(async runner => {
      await seedInvariantLedger(runner);
      await dropLedgerCompositeFks(runner);
      const [rejectedTx] = (await runner.query(
        `SELECT id FROM public.transfers WHERE status = 'REJECTED' LIMIT 1`,
      )) as Array<{ id: string }>;
      await runner.query(
        `INSERT INTO public.ledger_entries (transfer_id, account_id, direction, amount, balance_after)
         VALUES ($1, '99999999-9999-4999-8999-999999999999', 'DEBIT', 400000, -400000)`,
        [rejectedTx.id],
      );
    });

    const outcome = await service.reconcileOnce();
    expect(outcome).toMatchObject({
      executed: true,
      status: 'MISMATCH',
      totalDebit: '1650000',
      totalCredit: '1250000',
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: [],
    });
  });

  it('TC-117-05 detects Check 3 (SUM(accounts.balance) <> 0) in isolation when DEBIT = CREDIT and existing accounts match ledger', async () => {
    await withCommittedFixture(async runner => {
      const refs = await seedInvariantLedger(runner);
      await dropLedgerCompositeFks(runner);
      const [rejectedTx] = (await runner.query(
        `SELECT id FROM public.transfers WHERE status = 'REJECTED' LIMIT 1`,
      )) as Array<{ id: string }>;
      await runner.query(
        `INSERT INTO public.ledger_entries (transfer_id, account_id, direction, amount, balance_after)
         VALUES
           ($1, '99999999-9999-4999-8999-999999999999', 'DEBIT', 300000, -300000),
           ($1, $2, 'CREDIT', 300000, 1050000)`,
        [rejectedTx.id, refs.senderId],
      );
      await runner.query(`UPDATE public.accounts SET balance = balance + 300000 WHERE id = $1`, [
        refs.senderId,
      ]);
    });

    const outcome = await service.reconcileOnce();
    expect(outcome).toMatchObject({
      executed: true,
      status: 'MISMATCH',
      totalDebit: '1550000',
      totalCredit: '1550000',
      totalBalance: '300000',
      mismatchedAccounts: 0,
      details: [],
    });
  });

  it('TC-117-06 detects Check 4 (COMPLETED transfer missing 1 DEBIT + 1 CREDIT) in both zero-leg and cross-cancelled cases', async () => {
    const refs = await withCommittedFixture(async runner => seedInvariantLedger(runner));

    // (a) A COMPLETED transfer with 0 ledger_entries rows
    const [zeroLegTx] = await db.runner.connection.query<Array<{ id: string }>>(
      `INSERT INTO public.transfers (type, from_account_id, to_account_id, amount, status, initiated_by, correlation_id)
       VALUES ('TRANSFER', $1, $2, 100000, 'COMPLETED', $3, $4)
       RETURNING id`,
      [refs.senderId, refs.recipientId, refs.actorId, randomUUID()],
    );

    const zeroLegOutcome = await service.reconcileOnce();
    expect(zeroLegOutcome).toMatchObject({
      executed: true,
      status: 'MISMATCH',
      totalDebit: '1250000',
      totalCredit: '1250000',
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: [],
    });

    await withCommittedFixture(async runner => {
      await runner.query(
        `INSERT INTO public.ledger_entries (transfer_id, account_id, direction, amount, balance_after)
         VALUES
           ($1, $2, 'DEBIT', 100000, 650000),
           ($1, $3, 'CREDIT', 100000, 350000)`,
        [zeroLegTx.id, refs.senderId, refs.recipientId],
      );
      await runner.query('UPDATE public.accounts SET balance = balance - 100000 WHERE id = $1', [
        refs.senderId,
      ]);
      await runner.query('UPDATE public.accounts SET balance = balance + 100000 WHERE id = $1', [
        refs.recipientId,
      ]);
    });

    const repairedOutcome = await service.reconcileOnce();
    expect(repairedOutcome).toMatchObject({
      executed: true,
      status: 'OK',
      totalDebit: '1350000',
      totalCredit: '1350000',
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: [],
    });

    // (b) Two COMPLETED transfers each missing 1 leg that cancel out on senderId
    await withCommittedFixture(async runner => {
      await dropLedgerCompositeFks(runner);
      const [t1] = (await runner.query(
        `INSERT INTO public.transfers (type, from_account_id, to_account_id, amount, status, initiated_by, correlation_id)
         VALUES ('TRANSFER', $1, $2, 100000, 'COMPLETED', $3, $4)
         RETURNING id`,
        [refs.senderId, refs.recipientId, refs.actorId, randomUUID()],
      )) as Array<{ id: string }>;
      const [t2] = (await runner.query(
        `INSERT INTO public.transfers (type, from_account_id, to_account_id, amount, status, initiated_by, correlation_id)
         VALUES ('TRANSFER', $1, $2, 100000, 'COMPLETED', $3, $4)
         RETURNING id`,
        [refs.recipientId, refs.senderId, refs.actorId, randomUUID()],
      )) as Array<{ id: string }>;
      await runner.query(
        `INSERT INTO public.ledger_entries (transfer_id, account_id, direction, amount, balance_after)
         VALUES
           ($1, $3, 'DEBIT', 100000, 550000),
           ($2, $3, 'CREDIT', 100000, 650000)`,
        [t1.id, t2.id, refs.senderId],
      );
    });

    const crossCancelledOutcome = await service.reconcileOnce();
    expect(crossCancelledOutcome).toMatchObject({
      executed: true,
      status: 'MISMATCH',
      totalDebit: '1450000',
      totalCredit: '1450000',
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: [],
    });
  });

  it('TC-117-07 records status = ERROR when (a) totals overflow signed 64-bit bigint (BL-165) or (b) statement_timeout (57014) fires', async () => {
    // (a) Cumulative total_debit / total_credit > 9223372036854775807
    await withCommittedFixture(async runner => {
      const refs = await seedInvariantAccounts(runner);
      const hugeAmount = '5000000000000000000'; // 5 * 10^18; two transfers sum to 10^19 > max int64
      await postInvariantTransfer(runner, {
        actorId: refs.actorId,
        from: INVARIANT_FUNDING_ID,
        to: refs.senderId,
        amount: hugeAmount,
        type: 'DEPOSIT',
      });
      await postInvariantTransfer(runner, {
        actorId: refs.actorId,
        from: refs.senderId,
        to: refs.recipientId,
        amount: hugeAmount,
        type: 'TRANSFER',
      });
    });

    const overflowOutcome = await service.reconcileOnce();
    expect(overflowOutcome).toMatchObject({
      executed: true,
      status: 'ERROR',
      totalDebit: null,
      totalCredit: null,
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: null,
    });

    // (b) Deterministic statement_timeout (57014): statementTimeoutMs = 100 < lockTimeoutMs = 2000
    const blocker = db.runner.connection.createQueryRunner();
    await blocker.connect();
    try {
      await blocker.startTransaction();
      await blocker.query('LOCK TABLE public.ledger_entries IN ACCESS EXCLUSIVE MODE');

      const timeoutOutcome = await service.reconcileOnce({ statementTimeoutMs: 100 });
      expect(timeoutOutcome).toMatchObject({
        executed: true,
        status: 'ERROR',
        totalDebit: null,
        totalCredit: null,
        totalBalance: null,
        mismatchedAccounts: 0,
        details: null,
      });
    } finally {
      if (blocker.isTransactionActive) {
        await blocker.rollbackTransaction();
      }
      await blocker.release();
    }

    const rows = await fetchRuns();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      status: 'ERROR',
      total_debit: null,
      total_credit: null,
      total_balance: '0',
      mismatched_accounts: 0,
      details: null,
    });
    expect(rows[1]).toMatchObject({
      status: 'ERROR',
      total_debit: null,
      total_credit: null,
      total_balance: null,
      mismatched_accounts: 0,
      details: null,
    });
  });

  it('TC-117-08 enforces single-instance execution via pg_try_advisory_xact_lock(20261108, 117)', async () => {
    const holder = db.runner.connection.createQueryRunner();
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1, $2)', [
        RECONCILIATION_ADVISORY_LOCK_KEY[0],
        RECONCILIATION_ADVISORY_LOCK_KEY[1],
      ]);

      const skipped = await service.reconcileOnce();
      expect(skipped).toEqual({ executed: false });
      expect(await fetchRuns()).toHaveLength(0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1, $2)', [
        RECONCILIATION_ADVISORY_LOCK_KEY[0],
        RECONCILIATION_ADVISORY_LOCK_KEY[1],
      ]);
      await holder.release();
    }

    const executedAfterRelease = await service.reconcileOnce();
    expect(executedAfterRelease).toMatchObject({
      executed: true,
      status: 'OK',
    });
    expect(await fetchRuns()).toHaveLength(1);
  });

  it('TC-117-09 runs read-only without blocking on or acquiring write locks on public.accounts', async () => {
    const refs = await withCommittedFixture(async runner => seedInvariantLedger(runner));

    const writer = db.runner.connection.createQueryRunner();
    await writer.connect();
    try {
      await writer.startTransaction();
      await writer.query('SELECT id FROM public.accounts WHERE id = $1 FOR UPDATE', [
        refs.senderId,
      ]);

      const outcome = await service.reconcileOnce();
      expect(outcome).toMatchObject({
        executed: true,
        status: 'OK',
        mismatchedAccounts: 0,
      });

      // Also inspect pg_locks inside a transaction that executes RECONCILIATION_CHECK_SQL
      const inspector = db.runner.connection.createQueryRunner();
      await inspector.connect();
      try {
        await inspector.startTransaction();
        await inspector.query(RECONCILIATION_CHECK_SQL);
        const locks = (await inspector.query(
          `SELECT mode
           FROM pg_locks
           WHERE pid = pg_backend_pid()
             AND relation = 'public.accounts'::regclass`,
        )) as Array<{ mode: string }>;
        expect(locks.map(l => l.mode)).toEqual(['AccessShareLock']);
        await inspector.rollbackTransaction();
      } finally {
        await inspector.release();
      }
    } finally {
      if (writer.isTransactionActive) {
        await writer.rollbackTransaction();
      }
      await writer.release();
    }
  });

  it('TC-117-11 reconciles 100,000 ledger_entries rows (50,000 COMPLETED transfers) and records elapsed time', async () => {
    const refs = await withCommittedFixture(async runner => seedInvariantAccounts(runner));

    await db.runner.connection.query(
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
         FROM generate_series(1, 50000)
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
      [INVARIANT_FUNDING_ID, refs.senderId, refs.actorId],
    );

    await db.runner.connection.query(
      'UPDATE public.accounts SET balance = -50000000 WHERE id = $1',
      [INVARIANT_FUNDING_ID],
    );
    await db.runner.connection.query(
      'UPDATE public.accounts SET balance = 50000000 WHERE id = $1',
      [refs.senderId],
    );
    await db.runner.connection.query(
      'ANALYZE public.accounts, public.transfers, public.ledger_entries',
    );

    const [{ count }] = await db.runner.connection.query<Array<{ count: number }>>(
      'SELECT COUNT(*)::int AS count FROM public.ledger_entries',
    );
    expect(count).toBe(100_000);

    const t0 = performance.now();
    const outcome = await service.reconcileOnce();
    const durationMs = Math.round(performance.now() - t0);

    expect(outcome).toMatchObject({
      executed: true,
      status: 'OK',
      totalDebit: '50000000',
      totalCredit: '50000000',
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: [],
    });
    expect(durationMs).toBeLessThan(10_000);
  }, 60_000);
});
