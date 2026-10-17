/**
 * A signed account balance in whole dong, exact, never a `number`.
 *
 * Why a second type next to `Money`: the SYSTEM `funding` account is negative by design (ADR-09:
 * "funding is negative by exactly the total deposited"), and a deposit is a transfer FROM it. With
 * only a non-negative `Money`, the first deposit (0 - 300000) and reading `funding`'s balance or
 * the `fromBalanceBefore` of a DEPOSIT event would all throw. A `Balance` covers the whole range of
 * a Postgres `bigint` column: `accounts.balance`, `ledger_entries.balance_after`, reconciliation
 * sums.
 *
 * The type does NOT say "a customer balance is never below 0": that is BR-03, kept by the sync
 * guard (INSUFFICIENT_FUNDS) and by `accounts_balance_non_negative`. `debitBalance` happily goes
 * negative, because `funding` really does.
 */
import { MoneyError, parseWholeNumber, type Money } from './money';

declare const balanceBrand: unique symbol;

export type Balance = bigint & { readonly [balanceBrand]: true };

const BALANCE_MAX = 2n ** 63n - 1n;
const BALANCE_MIN = -(2n ** 63n);

export const BALANCE_ZERO = 0n as Balance;

/**
 * A canonical decimal string (optional leading minus, no "-0", no leading zero) to a Balance.
 * Throws `MoneyError`: INVALID for a wrong shape or type, OVERFLOW outside [-2^63, 2^63 - 1].
 */
export function parseBalance(raw: string): Balance {
  return parseWholeNumber(raw, true, BALANCE_MIN, BALANCE_MAX) as Balance;
}

/** Checks a `bigint` computed elsewhere (a reconciliation SUM, say) and brands it. */
export function toBalance(value: bigint): Balance {
  if (typeof value !== 'bigint') throw new MoneyError('INVALID');
  if (value < BALANCE_MIN || value > BALANCE_MAX) throw new MoneyError('OVERFLOW');
  return value as Balance;
}

/** The canonical string; a negative balance keeps its minus sign. For SQL parameters and events. */
export function formatBalance(value: Balance): string {
  if (typeof value !== 'bigint' || value < BALANCE_MIN || value > BALANCE_MAX) {
    throw new MoneyError('INVALID');
  }
  return value.toString();
}

/** `balance + amount`; past the top of the range throws OVERFLOW. */
export function creditBalance(balance: Balance, amount: Money): Balance {
  const result = balance + amount;
  if (result > BALANCE_MAX) throw new MoneyError('OVERFLOW');
  return result as Balance;
}

/**
 * `balance - amount`. May go below zero (the funding account does); below -2^63 throws OVERFLOW.
 * Whether the account may go negative at all is the caller's rule, not this function's.
 */
export function debitBalance(balance: Balance, amount: Money): Balance {
  const result = balance - amount;
  if (result < BALANCE_MIN) throw new MoneyError('OVERFLOW');
  return result as Balance;
}
