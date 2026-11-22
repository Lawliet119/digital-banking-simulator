/**
 * Two-integer PostgreSQL advisory lock key `(classid, objid)` used by the ledger reconciliation
 * job (`pg_try_advisory_xact_lock(20261108, 117)`) so at most one worker instance runs a
 * reconciliation check at a time (`DBS-117` DoD #1).
 */
export const RECONCILIATION_ADVISORY_LOCK_KEY = [20261108, 117] as const;

export type ReconciliationStatus = 'OK' | 'MISMATCH' | 'ERROR';

export interface MismatchedAccountDetail {
  accountId: string;
  balance: string;
  ledgerBalance: string;
}

export interface RawReconciliationSnapshot {
  total_debit: string;
  total_credit: string;
  total_balance: string;
  debit_equals_credit: boolean;
  total_balance_is_zero: boolean;
  completed_pairs_valid: boolean;
  daily_counters_valid: boolean;
  mismatched_details: MismatchedAccountDetail[];
}

export interface ClassifiedReconciliationRun {
  status: ReconciliationStatus;
  totalDebit: string | null;
  totalCredit: string | null;
  totalBalance: string | null;
  mismatchedAccounts: number;
  details: MismatchedAccountDetail[] | null;
}

export type ReconciliationOutcome =
  | { executed: false }
  | ({
      executed: true;
      startedAt: Date;
      finishedAt: Date;
    } & ClassifiedReconciliationRun);

const SIGNED_INT64_PATTERN = /^(0|-?[1-9]\d{0,18})$/;
const MIN_SIGNED_BIGINT = -9223372036854775808n;
const MAX_SIGNED_BIGINT = 9223372036854775807n;

/**
 * True when `value` is a canonical decimal integer string within PostgreSQL's signed 64-bit
 * `bigint` range `[-9223372036854775808, 9223372036854775807]`.
 */
export function isSignedBigIntString(value: string): boolean {
  if (!SIGNED_INT64_PATTERN.test(value)) {
    return false;
  }
  const parsed = BigInt(value);
  return parsed >= MIN_SIGNED_BIGINT && parsed <= MAX_SIGNED_BIGINT;
}

/**
 * Names the checks a snapshot failed, for the log line of a `MISMATCH` (`BL-421`): the row of
 * `reconciliation_runs` keeps account detail for balances only, so a run that failed on totals, on
 * the pairs of a COMPLETED transfer or on the daily debit counter would otherwise not say which.
 * Names only, no account id and no amount.
 */
export function failedReconciliationChecks(raw: RawReconciliationSnapshot): string[] {
  const failed: string[] = [];
  if (!raw.debit_equals_credit) failed.push('debit_equals_credit');
  if (raw.mismatched_details.length > 0) failed.push('account_balances');
  if (!raw.total_balance_is_zero) failed.push('total_balance_is_zero');
  if (!raw.completed_pairs_valid) failed.push('completed_pairs');
  if (!raw.daily_counters_valid) failed.push('daily_debit_counters');
  return failed;
}

/**
 * Classifies the read-only snapshot from `RECONCILIATION_CHECK_SQL` into `OK`, `MISMATCH`, or
 * `ERROR` (`DBS-117` DoD #2, DoD #3, `BL-165`). A daily debit counter that disagrees with the ledger
 * (`BL-421`) is a `MISMATCH` that names no account: the row's `details` stay for balances only.
 *
 * When any aggregate (`total_debit`, `total_credit`, `total_balance`, or a per-account
 * `ledgerBalance` / `balance`) overflows signed 64-bit `bigint`, the run is classified as
 * `ERROR` with overflowing totals set to `null`, `mismatchedAccounts = 0`, and `details = null`
 * so inserting into `public.reconciliation_runs` never fails with `22003` or `23514`.
 */
export function classifyReconciliationSnapshot(
  raw: RawReconciliationSnapshot,
): ClassifiedReconciliationRun {
  const debitFits = isSignedBigIntString(raw.total_debit);
  const creditFits = isSignedBigIntString(raw.total_credit);
  const balanceFits = isSignedBigIntString(raw.total_balance);
  const detailsFit = raw.mismatched_details.every(
    item => isSignedBigIntString(item.balance) && isSignedBigIntString(item.ledgerBalance),
  );

  if (!debitFits || !creditFits || !balanceFits || !detailsFit) {
    return {
      status: 'ERROR',
      totalDebit: debitFits ? raw.total_debit : null,
      totalCredit: creditFits ? raw.total_credit : null,
      totalBalance: balanceFits ? raw.total_balance : null,
      mismatchedAccounts: 0,
      details: null,
    };
  }

  const allChecksPass =
    raw.debit_equals_credit &&
    raw.total_balance_is_zero &&
    raw.completed_pairs_valid &&
    raw.daily_counters_valid &&
    raw.mismatched_details.length === 0;

  return {
    status: allChecksPass ? 'OK' : 'MISMATCH',
    totalDebit: raw.total_debit,
    totalCredit: raw.total_credit,
    totalBalance: raw.total_balance,
    mismatchedAccounts: raw.mismatched_details.length,
    details: raw.mismatched_details,
  };
}
