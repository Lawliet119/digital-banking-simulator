/**
 * Money in whole dong (BR-01), exact, never a `number`.
 *
 * Why this exists: JSON numbers and `parseInt`/`Number` round everything above 2^53, so
 * 9007199254740993 comes back as 9007199254740992 without any error. The `pg` driver returns
 * BIGINT as a string for the same reason. Every module therefore keeps money as a decimal STRING
 * on the wire and as a `bigint` inside the domain, and crosses between the two only here.
 *
 *  - `Money`   an amount of one transfer or deposit, 0 .. 2^63-1 (the range of a Postgres bigint).
 *  - `Balance` a signed account balance (balance.ts). The SYSTEM `funding` account is negative by
 *              design (ADR-09), which `Money` cannot represent.
 *
 * The branded types stop a bare `bigint` (unchecked, maybe negative or out of range) from being
 * passed where an amount is expected: to get one you go through `parseMoney` or `toMoney`.
 */

declare const moneyBrand: unique symbol;

export type Money = bigint & { readonly [moneyBrand]: true };

/** Largest value of a Postgres `bigint` column, hence the largest Money. */
const MAX = 2n ** 63n - 1n;

export const MONEY_MAX = MAX as Money;
export const MONEY_ZERO = 0n as Money;

/**
 *  INVALID      not a string of the expected shape (or not a bigint, for `toMoney`)
 *  OVERFLOW     well formed but outside the range
 *  UNDERFLOW    a subtraction that would go below zero
 *  NOT_POSITIVE zero, where an amount greater than zero is required
 */
export type MoneyErrorReason = 'INVALID' | 'OVERFLOW' | 'UNDERFLOW' | 'NOT_POSITIVE';

const MESSAGES: Record<MoneyErrorReason, string> = {
  INVALID: 'Not a valid money value',
  OVERFLOW: 'Money value is outside the supported range',
  UNDERFLOW: 'Money subtraction would go below zero',
  NOT_POSITIVE: 'Money value must be greater than zero',
};

/**
 * Programming or data error, not an HTTP error: a caller that cares catches it, anything else
 * reaches `ProblemDetailsFilter` as a generic 500. The message never repeats the offending value:
 * it can be long garbage from a client, and it ends up in logs.
 */
export class MoneyError extends Error {
  constructor(readonly reason: MoneyErrorReason) {
    super(MESSAGES[reason]);
    this.name = 'MoneyError';
  }
}

/** 0, or digits with no leading zero. No sign, no space, no decimal point, no exponent. */
const UNSIGNED = /^(0|[1-9][0-9]*)$/;
/** Same, with an optional minus sign on a non-zero number ("-0" is not a number we accept). */
const SIGNED = /^(0|-?[1-9][0-9]*)$/;

/** 2^63 has 19 digits, so 20 or more digits cannot fit; refuse them before calling `BigInt`. */
const MAX_DIGITS = 19;

/**
 * The one place a money string becomes a bigint. In this order:
 *  1. not a string, or not the canonical shape        -> INVALID
 *  2. more than 19 digits                             -> OVERFLOW, without calling BigInt
 *  3. outside [min, max]                              -> OVERFLOW
 * Shared with balance.ts; not exported from the public index.
 * @internal
 */
export function parseWholeNumber(raw: unknown, signed: boolean, min: bigint, max: bigint): bigint {
  if (typeof raw !== 'string' || !(signed ? SIGNED : UNSIGNED).test(raw)) {
    throw new MoneyError('INVALID');
  }
  const digits = raw.startsWith('-') ? raw.length - 1 : raw.length;
  if (digits > MAX_DIGITS) throw new MoneyError('OVERFLOW');
  const value = BigInt(raw);
  if (value < min || value > max) throw new MoneyError('OVERFLOW');
  return value;
}

/** A canonical decimal string to a Money, 0 included. Throws `MoneyError`. */
export function parseMoney(raw: string): Money {
  return parseWholeNumber(raw, false, 0n, MAX) as Money;
}

/** Like `parseMoney` but refuses zero: use it for the amount of a transfer or deposit. */
export function parsePositiveMoney(raw: string): Money {
  const value = parseMoney(raw);
  if (value === MONEY_ZERO) throw new MoneyError('NOT_POSITIVE');
  return value;
}

/** `parseMoney` for input of unknown type; `null` instead of a throw. */
export function tryParseMoney(raw: unknown): Money | null {
  try {
    return parseMoney(raw as string);
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

/** Checks a `bigint` computed elsewhere (a SUM, say) and brands it. */
export function toMoney(value: bigint): Money {
  if (typeof value !== 'bigint' || value < 0n) throw new MoneyError('INVALID');
  if (value > MAX) throw new MoneyError('OVERFLOW');
  return value as Money;
}

/**
 * The canonical string: decimal digits, no separators. Not a display format ("1.500.000đ" belongs
 * to the UI). Use it for SQL parameters, API responses and event fields.
 */
export function formatMoney(value: Money): string {
  if (typeof value !== 'bigint' || value < 0n || value > MAX) throw new MoneyError('INVALID');
  return value.toString();
}

export function addMoney(a: Money, b: Money): Money {
  const sum = a + b;
  if (sum > MAX) throw new MoneyError('OVERFLOW');
  return sum as Money;
}

/** Never returns a negative Money: a customer balance below the amount is the sync guard's call. */
export function subtractMoney(a: Money, b: Money): Money {
  if (a < b) throw new MoneyError('UNDERFLOW');
  return (a - b) as Money;
}
