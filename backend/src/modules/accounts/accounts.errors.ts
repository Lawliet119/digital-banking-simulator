/**
 * Internal errors of the accounts primitives. None is an HttpException and none carries an
 * ErrorCode: each one means the caller's guard or transaction protocol has a bug, so it must reach
 * the client as a 500. The ledger decides REJECTED before it changes a balance, because after
 * PostgreSQL refuses an UPDATE the transaction is aborted and can no longer record the rejection,
 * its audit row or its idempotent response (BR-07).
 */

/** The caller changed a balance it had not locked in this same outermost transaction. */
export class AccountNotLockedError extends Error {
  override readonly name = 'AccountNotLockedError';

  constructor(readonly accountId: string) {
    super(
      'Account must be locked with lockForUpdate in this transaction before its balance changes',
    );
  }
}
