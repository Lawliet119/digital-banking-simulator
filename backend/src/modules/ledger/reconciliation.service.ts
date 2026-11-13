import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import { limitsConfig } from '@config/limits.config';
import { TransactionService } from '@database/transaction.service';
import { Clock } from '@common/clock';
import { runsWorkers } from '@common/app-role/app-role';
import { safeErrorMetadata } from '@common/logging/logging.options';
import { PollingLoop } from '@common/utils/polling-loop';
import { countReconciliationRun } from './reconciliation.metrics';
import {
  classifyReconciliationSnapshot,
  RECONCILIATION_ADVISORY_LOCK_KEY,
  type ClassifiedReconciliationRun,
  type MismatchedAccountDetail,
  type RawReconciliationSnapshot,
  type ReconciliationOutcome,
} from './reconciliation.types';

const DEFAULT_RECONCILIATION_STATEMENT_TIMEOUT_MS = 60_000;

/**
 * Single read-only MVCC snapshot query checking all 4 ledger invariants (`DBS-117` DoD #2, #3):
 * 1. Total DEBIT equals total CREDIT across `public.ledger_entries`.
 * 2. Every row in `public.accounts` has `balance = SUM(CREDIT) - SUM(DEBIT)`.
 * 3. `SUM(accounts.balance) = 0`.
 * 4. Every `COMPLETED` transfer in `public.v_transfer_facts` has exactly 1 matching `DEBIT` and
 *    1 matching `CREDIT` in `public.ledger_entries`.
 *
 * Uses `public.v_transfer_facts` (never `public.transfers`) so the least-privilege `dbs_worker`
 * role (`database-design.md` §8.1) can execute it without `SELECT` on `transfers`.
 */
export const RECONCILIATION_CHECK_SQL = `
WITH
  entry_by_account AS (
    SELECT
      account_id,
      COALESCE(SUM(amount::numeric) FILTER (WHERE direction = 'DEBIT'), 0) AS debit_amount,
      COALESCE(SUM(amount::numeric) FILTER (WHERE direction = 'CREDIT'), 0) AS credit_amount
    FROM public.ledger_entries
    GROUP BY account_id
  ),
  entry_totals AS (
    SELECT
      COALESCE(SUM(debit_amount), 0) AS debit,
      COALESCE(SUM(credit_amount), 0) AS credit
    FROM entry_by_account
  ),
  balance_sum AS (
    SELECT COALESCE(SUM(balance::numeric), 0) AS total_balance
    FROM public.accounts
  ),
  account_diffs AS (
    SELECT
      a.id AS account_id,
      a.balance::text AS balance,
      COALESCE(e.credit_amount - e.debit_amount, 0)::text AS ledger_balance
    FROM public.accounts a
    LEFT JOIN entry_by_account e ON e.account_id = a.id
    WHERE a.balance::numeric <> COALESCE(e.credit_amount - e.debit_amount, 0)
    ORDER BY a.id ASC
  ),
  invalid_completed_transfers AS (
    SELECT t.id
    FROM public.v_transfer_facts t
    LEFT JOIN public.ledger_entries e ON e.transfer_id = t.id
    WHERE t.status = 'COMPLETED'
    GROUP BY t.id, t.amount, t.from_account_id, t.to_account_id
    HAVING
      COUNT(e.id) <> 2
      OR COUNT(e.id) FILTER (
        WHERE e.direction = 'DEBIT'
          AND e.amount = t.amount
          AND e.account_id = t.from_account_id
      ) <> 1
      OR COUNT(e.id) FILTER (
        WHERE e.direction = 'CREDIT'
          AND e.amount = t.amount
          AND e.account_id = t.to_account_id
      ) <> 1
    LIMIT 1
  )
SELECT
  et.debit::text AS total_debit,
  et.credit::text AS total_credit,
  bs.total_balance::text AS total_balance,
  (et.debit = et.credit) AS debit_equals_credit,
  (bs.total_balance = 0) AS total_balance_is_zero,
  NOT EXISTS (SELECT 1 FROM invalid_completed_transfers) AS completed_pairs_valid,
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'accountId', d.account_id::text,
          'balance', d.balance,
          'ledgerBalance', d.ledger_balance
        )
        ORDER BY d.account_id ASC
      )
      FROM account_diffs d
    ),
    '[]'::jsonb
  ) AS mismatched_details
FROM entry_totals et
CROSS JOIN balance_sum bs
`;

const INSERT_RECONCILIATION_RUN_SQL = `
INSERT INTO public.reconciliation_runs (
  started_at,
  finished_at,
  status,
  total_debit,
  total_credit,
  total_balance,
  mismatched_accounts,
  details
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
`;

export interface ReconcileOnceOptions {
  statementTimeoutMs?: number;
}

@Injectable()
export class ReconciliationService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly loop = new PollingLoop(
    async () => {
      await this.reconcileOnce();
      return this.config.reconciliationIntervalMs;
    },
    error => this.logger.error(safeErrorMetadata(error), 'Ledger reconciliation loop failed'),
  );

  constructor(
    private readonly tx: TransactionService,
    private readonly clock: Clock,
    @Inject(limitsConfig.KEY) private readonly config: ConfigType<typeof limitsConfig>,
  ) {}

  onApplicationBootstrap(): void {
    if (!runsWorkers()) return;
    this.loop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /**
   * Executes one ledger reconciliation run under a transaction-level advisory lock
   * (`pg_try_advisory_xact_lock(20261108, 117)`). If another worker instance already holds the
   * lock, returns `{ executed: false }` immediately without querying the ledger or inserting a row.
   */
  async reconcileOnce(options?: ReconcileOnceOptions): Promise<ReconciliationOutcome> {
    const outcome = await this.runOnce(options);
    // Counted after the row is committed, once per run; a run that found the lock taken wrote
    // nothing and counts nothing. Read-only: it changes neither the SQL nor the result.
    if (outcome.executed) countReconciliationRun(outcome.status);
    return outcome;
  }

  private async runOnce(options?: ReconcileOnceOptions): Promise<ReconciliationOutcome> {
    const statementTimeoutMs =
      options?.statementTimeoutMs ?? DEFAULT_RECONCILIATION_STATEMENT_TIMEOUT_MS;
    let lockAcquired = false;
    let startedAt = this.clock.now();

    try {
      return await this.tx.run(
        async manager => {
          const lockRows = await manager.query<Array<{ acquired: boolean }>>(
            'SELECT pg_try_advisory_xact_lock($1, $2) AS acquired',
            [RECONCILIATION_ADVISORY_LOCK_KEY[0], RECONCILIATION_ADVISORY_LOCK_KEY[1]],
          );

          if (lockRows[0]?.acquired !== true) {
            return { executed: false };
          }

          lockAcquired = true;
          startedAt = this.clock.now();

          const rows = await manager.query<RawReconciliationSnapshot[]>(RECONCILIATION_CHECK_SQL);
          const raw = rows[0];
          const classified = classifyReconciliationSnapshot({
            total_debit: String(raw.total_debit),
            total_credit: String(raw.total_credit),
            total_balance: String(raw.total_balance),
            debit_equals_credit: Boolean(raw.debit_equals_credit),
            total_balance_is_zero: Boolean(raw.total_balance_is_zero),
            completed_pairs_valid: Boolean(raw.completed_pairs_valid),
            mismatched_details: Array.isArray(raw.mismatched_details)
              ? raw.mismatched_details
              : (JSON.parse(String(raw.mismatched_details)) as MismatchedAccountDetail[]),
          });
          const finishedAt = this.clock.now();

          await this.insertRun(manager, startedAt, finishedAt, classified);

          if (classified.status === 'MISMATCH') {
            this.logger.warn(
              {
                status: classified.status,
                mismatchedAccounts: classified.mismatchedAccounts,
                totalDebit: classified.totalDebit,
                totalCredit: classified.totalCredit,
                totalBalance: classified.totalBalance,
              },
              'Ledger reconciliation detected mismatch',
            );
          } else if (classified.status === 'ERROR') {
            this.logger.error(
              {
                status: classified.status,
              },
              'Ledger reconciliation aggregate overflowed signed bigint range',
            );
          }

          return {
            executed: true,
            startedAt,
            finishedAt,
            ...classified,
          };
        },
        { statementTimeoutMs, maxRetries: 0 },
      );
    } catch (error) {
      if (!lockAcquired) {
        throw error;
      }

      this.logger.error(
        safeErrorMetadata(error),
        'Ledger reconciliation query failed; recording ERROR run',
      );
      const finishedAt = this.clock.now();
      const errorRun: ClassifiedReconciliationRun = {
        status: 'ERROR',
        totalDebit: null,
        totalCredit: null,
        totalBalance: null,
        mismatchedAccounts: 0,
        details: null,
      };

      await this.tx.run(
        async manager => {
          await this.insertRun(manager, startedAt, finishedAt, errorRun);
        },
        { maxRetries: 0 },
      );

      return {
        executed: true,
        startedAt,
        finishedAt,
        ...errorRun,
      };
    }
  }

  private async insertRun(
    manager: EntityManager,
    startedAt: Date,
    finishedAt: Date,
    classified: ClassifiedReconciliationRun,
  ): Promise<void> {
    await manager.query(INSERT_RECONCILIATION_RUN_SQL, [
      startedAt,
      finishedAt,
      classified.status,
      classified.totalDebit,
      classified.totalCredit,
      classified.totalBalance,
      classified.mismatchedAccounts,
      classified.details === null ? null : JSON.stringify(classified.details),
    ]);
  }
}
