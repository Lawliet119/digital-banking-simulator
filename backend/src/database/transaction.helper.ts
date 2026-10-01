import type { DataSource, EntityManager } from 'typeorm';
import { isRetryableTransactionError } from '../common/utils/pg-error.util';

export type IsolationLevel =
  'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export interface TransactionOptions {
  /** Default READ COMMITTED: correctness comes from `SELECT … FOR UPDATE`, not from isolation. */
  isolationLevel?: IsolationLevel;
  /** How many times to re-run after a deadlock / serialization failure. Default 3. */
  maxRetries?: number;
  /** First backoff delay in ms; doubles each retry, with jitter. Default 20. */
  baseDelayMs?: number;
  /** Called before each retry (log it, count it as a metric). */
  onRetry?: (info: { attempt: number; error: unknown }) => void;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 20;

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
    onRetry,
    sleep = realSleep,
  } = options;

  for (let attempt = 0; ; attempt++) {
    const queryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction(isolationLevel);
      const result = await fn(queryRunner.manager);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
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
      await queryRunner.release();
    }
  }
}
