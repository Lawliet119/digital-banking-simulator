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

/** PostgreSQL refused to take a customer balance below zero (CHECK accounts_balance_non_negative). */
export class AccountBalanceNegativeError extends Error {
  override readonly name = 'AccountBalanceNegativeError';

  constructor(
    readonly accountId: string,
    options: { cause: unknown },
  ) {
    super('Customer balance would become negative', options);
  }
}

/** The new balance or the delta does not fit PostgreSQL's signed bigint. */
export class AccountBalanceOverflowError extends Error {
  override readonly name = 'AccountBalanceOverflowError';

  constructor(
    readonly accountId: string,
    options: { cause: unknown },
  ) {
    super('Balance is outside the signed bigint range', options);
  }
}
