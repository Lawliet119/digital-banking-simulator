/**
 * Classification of database errors.
 *
 * Two different questions, two different sets:
 *  - isRetryableTransactionError: safe to re-run the WHOLE transaction right now (the database
 *    rolled it back on purpose because of a conflict). Timeouts are deliberately NOT here: a
 *    request that already waited too long would only deepen the queue by waiting again.
 *  - isTransientDbError: the failure is temporary and unrelated to the request's content, so the
 *    HTTP layer answers 503 + Retry-After instead of 500.
 *
 * Errors are inspected by walking `error`, `error.driverError` (TypeORM QueryFailedError) and
 * `error.cause`, because the SQLSTATE `code` lives at different depths depending on the caller.
 */

/** PostgreSQL SQLSTATE codes we branch on. */
export const PgErrorCode = {
  UNIQUE_VIOLATION: '23505',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
  /** statement_timeout fired. */
  QUERY_CANCELED: '57014',
  /** idle_in_transaction_session_timeout fired: the server closed the session. */
  IDLE_IN_TRANSACTION_TIMEOUT: '25P03',
  ADMIN_SHUTDOWN: '57P01',
  CANNOT_CONNECT_NOW: '57P03',
  TOO_MANY_CONNECTIONS: '53300',
  CONNECTION_EXCEPTION: '08000',
  CONNECTION_DOES_NOT_EXIST: '08003',
  CONNECTION_FAILURE: '08006',
  SQLCLIENT_UNABLE_TO_ESTABLISH: '08001',
} as const;

const RETRYABLE_TRANSACTION_CODES: ReadonlySet<string> = new Set([
  PgErrorCode.DEADLOCK_DETECTED,
  PgErrorCode.SERIALIZATION_FAILURE,
]);

const TRANSIENT_PG_CODES: ReadonlySet<string> = new Set([
  ...RETRYABLE_TRANSACTION_CODES,
  PgErrorCode.LOCK_NOT_AVAILABLE,
  PgErrorCode.QUERY_CANCELED,
  PgErrorCode.IDLE_IN_TRANSACTION_TIMEOUT,
  PgErrorCode.ADMIN_SHUTDOWN,
  PgErrorCode.CANNOT_CONNECT_NOW,
  PgErrorCode.TOO_MANY_CONNECTIONS,
  PgErrorCode.CONNECTION_EXCEPTION,
  PgErrorCode.CONNECTION_DOES_NOT_EXIST,
  PgErrorCode.CONNECTION_FAILURE,
  PgErrorCode.SQLCLIENT_UNABLE_TO_ESTABLISH,
]);

/** Node socket-level errors that mean "the database was unreachable for a moment". */
const TRANSIENT_NODE_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

const MAX_CAUSE_DEPTH = 4;

/** First string `code` found on the error or anything it wraps. */
export function getErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === 'object'; depth++) {
    const record = current as { code?: unknown; driverError?: unknown; cause?: unknown };
    if (typeof record.code === 'string') return record.code;
    current = record.driverError ?? record.cause;
  }
  return undefined;
}

/** A conflict the database rolled back; re-running the whole transaction is safe. */
export function isRetryableTransactionError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code !== undefined && RETRYABLE_TRANSACTION_CODES.has(code);
}

/** A temporary database failure unrelated to the request itself (answer 503, not 500). */
export function isTransientDbError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code !== undefined && (TRANSIENT_PG_CODES.has(code) || TRANSIENT_NODE_CODES.has(code));
}

export function isUniqueViolation(error: unknown): boolean {
  return getErrorCode(error) === PgErrorCode.UNIQUE_VIOLATION;
}
