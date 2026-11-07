import { AsyncLocalStorage } from 'node:async_hooks';
import {
  QueryRunnerProviderAlreadyReleasedError,
  type DataSource,
  type EntityManager,
} from 'typeorm';
import { isRetryableTransactionError } from '../common/utils/pg-error.util';

/**
 * Set to `true` only while `fn` runs inside `withTransaction` (and reset on each retried
 * attempt), `undefined` everywhere else. Lets a caller like `AuditService.recordDenied` detect
 * — and refuse — being invoked from inside another already-open transaction, without needing a
 * `manager` parameter of its own. Tracks the async call chain, not lexical scope: a caller nested
 * through an awaited async helper is still detected, but one that escapes via an EventEmitter
 * listener or `setImmediate` fired after `fn` has already returned is not (see
 * docs/features/DBS-56-audit-service-record.md, Vòng 2, R2).
 */
export const activeTransactionContext = new AsyncLocalStorage<true>();

export type IsolationLevel =
  'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export interface TransactionOptions {
  /** Default READ COMMITTED: correctness comes from `SELECT … FOR UPDATE`, not from isolation. */
  isolationLevel?: IsolationLevel;
  /** How many times to re-run after a deadlock / serialization failure. Default 3. */
  maxRetries?: number;
  /** First backoff delay in ms; doubles each retry, with jitter. Default 20. */
  baseDelayMs?: number;
  /**
   * How long this transaction may wait for a row lock. Default 2000. Without a limit, requests
   * queueing on one hot account each hold a pooled connection while they wait, and the pool runs
   * dry for every other request.
   */
  lockTimeoutMs?: number;
  /** Longest a single statement may run. Default 5000. */
  statementTimeoutMs?: number;
  /** Longest the transaction may sit idle between statements. Default 10000. */
  idleInTransactionTimeoutMs?: number;
  /** Called before each retry (log it, count it as a metric). */
  onRetry?: (info: { attempt: number; error: unknown }) => void;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 20;
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;

/**
 * `is_local = true` scopes each setting to this transaction. With `false` it would stay on the
 * pooled connection and change what the next, unrelated request can do.
 */
const APPLY_TIMEOUTS_SQL = `SELECT
  set_config('lock_timeout', $1, true),
  set_config('statement_timeout', $2, true),
  set_config('idle_in_transaction_session_timeout', $3, true)`;

/** The part of a pg client this file uses; absent on the fakes of unit tests. */
interface ConnectionEvents {
  on?: (event: 'error', listener: (cause: unknown) => void) => unknown;
  removeListener?: (event: 'error', listener: (cause: unknown) => void) => unknown;
}

/**
 * `idle_in_transaction_session_timeout` makes PostgreSQL close the session. TypeORM then releases
 * the runner on the client's `error` event, and the next query of the callback fails with
 * QueryRunnerProviderAlreadyReleasedError, which carries no SQLSTATE: the route answered 500 for
 * a failure that is temporary. When that is what happened, report the error that closed the
 * connection (25P03, or a code-less "terminated" error), which `isTransientDbError` understands.
 * Any other failure is returned as it is.
 */
function describeFailure(error: unknown, connectionError: unknown): unknown {
  return error instanceof QueryRunnerProviderAlreadyReleasedError && connectionError !== undefined
    ? connectionError
    : error;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Runs `fn` inside ONE database transaction and returns its result.
 *
 * - Everything `fn` does through the `manager` it receives commits together or rolls back
 *   together. This is what makes a transfer atomic (BR-02): no "debited but not credited".
 * - If the database aborts the transaction with a deadlock (40P01) or a serialization failure
 *   (40001), the whole of `fn` is run again in a fresh transaction, up to `maxRetries` times.
 *   Any other error rolls back and is rethrown untouched.
 * - Lock, statement and idle-in-transaction timeouts are always set for the transaction, so a
 *   stuck wait fails fast (503) instead of holding a pooled connection indefinitely.
 * - The connection is always returned to the pool.
 *
 * **`fn` must be safe to run more than once.** Do reads and writes through `manager` only. Never
 * call another service (Redis, HTTP, SQS) inside `fn`: a retry would repeat that side effect, and
 * the call would also hold row locks open while waiting. Publish events via the outbox table
 * (an INSERT in the same transaction) instead.
 *
 * Pass the same `manager` down to other modules (e.g. `accounts.lockForUpdate(ids, manager)`)
 * so they take part in the same transaction.
 */
export async function withTransaction<T>(
  dataSource: DataSource,
  fn: (manager: EntityManager) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const {
    isolationLevel = 'READ COMMITTED',
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS,
    idleInTransactionTimeoutMs = DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    onRetry,
    sleep = realSleep,
  } = options;

  for (let attempt = 0; ; attempt++) {
    const queryRunner = dataSource.createQueryRunner();
    // TypeORM drops the runner when the server closes the session and keeps no trace of why, so
    // the cause is kept here (see `describeFailure`).
    let connectionError: unknown;
    const onConnectionError = (cause: unknown) => {
      connectionError ??= cause;
    };
    let client: ConnectionEvents | undefined;
    try {
      await queryRunner.connect();
      client = (queryRunner as { databaseConnection?: ConnectionEvents }).databaseConnection;
      client?.on?.('error', onConnectionError);
      await queryRunner.startTransaction(isolationLevel);
      // Must be in force before the callback requests its first lock.
      await queryRunner.query(APPLY_TIMEOUTS_SQL, [
        `${lockTimeoutMs}ms`,
        `${statementTimeoutMs}ms`,
        `${idleInTransactionTimeoutMs}ms`,
      ]);
      const result = await activeTransactionContext.run(true, () => fn(queryRunner.manager));
      await queryRunner.commitTransaction();
      return result;
    } catch (raised) {
      const error = describeFailure(raised, connectionError);
      if (queryRunner.isTransactionActive) {
        try {
          await queryRunner.rollbackTransaction();
        } catch {
          // The original error is the useful one; a failed rollback must not hide it.
        }
      }
      if (!isRetryableTransactionError(error) || attempt >= maxRetries) {
        throw error;
      }
      onRetry?.({ attempt: attempt + 1, error });
      await sleep(baseDelayMs * 2 ** attempt * (0.5 + Math.random()));
    } finally {
      client?.removeListener?.('error', onConnectionError);
      await queryRunner.release();
    }
  }
}
