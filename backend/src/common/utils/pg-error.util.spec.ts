import {
  getErrorCode,
  isRetryableTransactionError,
  isTransientDbError,
  isUniqueViolation,
  PgErrorCode,
} from './pg-error.util';

/** Mimics TypeORM's QueryFailedError: the SQLSTATE sits on `driverError`, not on the error. */
const queryFailed = (code: string): Error =>
  Object.assign(new Error('query failed'), { driverError: { code } });

describe('pg-error.util', () => {
  describe('getErrorCode', () => {
    it('reads code from the error itself', () => {
      expect(getErrorCode(Object.assign(new Error('x'), { code: '40P01' }))).toBe('40P01');
    });

    it('reads code from driverError (TypeORM)', () => {
      expect(getErrorCode(queryFailed('23505'))).toBe('23505');
    });

    it('reads code from a nested cause', () => {
      const wrapped = new Error('outer', { cause: { code: 'ECONNRESET' } });
      expect(getErrorCode(wrapped)).toBe('ECONNRESET');
    });

    it('gives up on non-objects and cyclic chains', () => {
      expect(getErrorCode(undefined)).toBeUndefined();
      expect(getErrorCode('boom')).toBeUndefined();
      const loop: { cause?: unknown } = {};
      loop.cause = loop;
      expect(getErrorCode(loop)).toBeUndefined();
    });
  });

  describe('isRetryableTransactionError', () => {
    it.each([PgErrorCode.DEADLOCK_DETECTED, PgErrorCode.SERIALIZATION_FAILURE])(
      'is true for %s',
      code => {
        expect(isRetryableTransactionError(queryFailed(code))).toBe(true);
      },
    );

    it.each([PgErrorCode.UNIQUE_VIOLATION, PgErrorCode.CONNECTION_FAILURE, '42P01'])(
      'is false for %s (re-running would not help or would hide a bug)',
      code => {
        expect(isRetryableTransactionError(queryFailed(code))).toBe(false);
      },
    );

    it('is false for an error with no code', () => {
      expect(isRetryableTransactionError(new Error('plain'))).toBe(false);
    });

    it.each([
      PgErrorCode.LOCK_NOT_AVAILABLE,
      PgErrorCode.QUERY_CANCELED,
      PgErrorCode.IDLE_IN_TRANSACTION_TIMEOUT,
    ])(
      'is false for the timeout %s: re-running a request that already waited too long only deepens the queue',
      code => {
        expect(isRetryableTransactionError(queryFailed(code))).toBe(false);
      },
    );
  });

  describe('isTransientDbError', () => {
    it.each([
      PgErrorCode.DEADLOCK_DETECTED,
      PgErrorCode.TOO_MANY_CONNECTIONS,
      PgErrorCode.CONNECTION_FAILURE,
      PgErrorCode.ADMIN_SHUTDOWN,
    ])('is true for pg code %s', code => {
      expect(isTransientDbError(queryFailed(code))).toBe(true);
    });

    it.each([
      PgErrorCode.LOCK_NOT_AVAILABLE,
      PgErrorCode.QUERY_CANCELED,
      PgErrorCode.IDLE_IN_TRANSACTION_TIMEOUT,
    ])('is true for the timeout %s, so the client gets a retryable 503 instead of a 500', code => {
      expect(isTransientDbError(queryFailed(code))).toBe(true);
    });

    it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'])('is true for node code %s', code => {
      expect(isTransientDbError(Object.assign(new Error('socket'), { code }))).toBe(true);
    });

    it('is false for a constraint violation or a syntax error', () => {
      expect(isTransientDbError(queryFailed(PgErrorCode.UNIQUE_VIOLATION))).toBe(false);
      expect(isTransientDbError(queryFailed('42601'))).toBe(false);
    });
  });

  describe('isUniqueViolation', () => {
    it('detects 23505 only', () => {
      expect(isUniqueViolation(queryFailed('23505'))).toBe(true);
      expect(isUniqueViolation(queryFailed('40P01'))).toBe(false);
    });
  });
});
