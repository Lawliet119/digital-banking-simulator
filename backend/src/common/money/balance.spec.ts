import { BALANCE_REJECT, NON_STRING_INPUTS } from '../../../test/support/money-cases';
import {
  BALANCE_ZERO,
  creditBalance,
  debitBalance,
  formatBalance,
  parseBalance,
  toBalance,
  type Balance,
} from './balance';
import { MONEY_MAX, MoneyError, addMoney, formatMoney, parseMoney, type Money } from './money';

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof MoneyError) return error.reason;
    throw error;
  }
  return 'NO_ERROR';
}

const balance = (digits: string): Balance => parseBalance(digits);
const money = (digits: string): Money => parseMoney(digits);

describe('Balance (DBS-22)', () => {
  it('TC-22-13 parses signed canonical strings exactly and formats them back', () => {
    const accepted: [string, bigint][] = [
      ['0', 0n],
      ['300000', 300_000n],
      ['-300000', -300_000n],
      ['9223372036854775807', 2n ** 63n - 1n],
      ['-9223372036854775808', -(2n ** 63n)],
      ['-9007199254740993', -9_007_199_254_740_993n], // below -2^53 and still exact
      ['-9007199254740992', -9_007_199_254_740_992n],
    ];
    for (const [text, value] of accepted) {
      expect(parseBalance(text)).toBe(value);
      expect(formatBalance(parseBalance(text))).toBe(text);
    }
  });

  it.each(BALANCE_REJECT.filter(c => c.reason === 'INVALID'))(
    'TC-22-14 refuses %j as INVALID',
    ({ input }) => {
      expect(reasonOf(() => parseBalance(input))).toBe('INVALID');
    },
  );

  it.each(BALANCE_REJECT.filter(c => c.reason === 'OVERFLOW'))(
    'TC-22-14 refuses a %# value outside [-2^63, 2^63 - 1] as OVERFLOW',
    ({ input }) => {
      expect(reasonOf(() => parseBalance(input))).toBe('OVERFLOW');
    },
  );

  it('TC-22-14 refuses everything that is not a string', () => {
    for (const input of NON_STRING_INPUTS) {
      expect(reasonOf(() => parseBalance(input as string))).toBe('INVALID');
    }
  });

  it('TC-22-15 follows the funding scenario of docs/02 §7.3 and sums to zero', () => {
    // Deposit 1,000,000 to A; A sends 300,000 to B. funding starts at zero and goes negative.
    const deposit = money('1000000');
    const funding = debitBalance(BALANCE_ZERO, deposit);
    expect(funding).toBe(-1_000_000n);
    expect(formatBalance(funding)).toBe('-1000000');

    // What the next deposit's event carries as fromBalanceBefore, read back from the database.
    expect(parseBalance('-1000000')).toBe(funding);

    let a = creditBalance(BALANCE_ZERO, deposit);
    a = debitBalance(a, money('300000'));
    const b = creditBalance(BALANCE_ZERO, money('300000'));
    expect([a, b]).toEqual([700_000n, 300_000n]);

    // Reconciliation check 3: the balances of all accounts add up to 0.
    expect(toBalance(funding + a + b)).toBe(0n);
  });

  it('TC-22-16 stays inside the bigint range and leaves "enough funds" to the sync guard', () => {
    const balanceMax = balance('9223372036854775807');
    const balanceMin = balance('-9223372036854775808');
    const one = money('1');

    expect(reasonOf(() => creditBalance(balanceMax, one))).toBe('OVERFLOW');
    expect(reasonOf(() => debitBalance(balanceMin, one))).toBe('OVERFLOW');
    expect(creditBalance(balanceMin, MONEY_MAX)).toBe(-1n);
    expect(debitBalance(balance('500000'), money('300000'))).toBe(200_000n);
    // Allowed on purpose: BR-03 (a customer balance never below 0) is the sync guard's rule
    // and the CHECK constraint's, not the type's. The funding account really does go below 0.
    expect(debitBalance(BALANCE_ZERO, one)).toBe(-1n);
  });

  it('TC-22-11 toBalance checks a computed bigint', () => {
    expect(toBalance(0n)).toBe(0n);
    expect(toBalance(-(2n ** 63n))).toBe(-(2n ** 63n));
    expect(toBalance(2n ** 63n - 1n)).toBe(2n ** 63n - 1n);
    expect(reasonOf(() => toBalance(2n ** 63n))).toBe('OVERFLOW');
    expect(reasonOf(() => toBalance(-(2n ** 63n) - 1n))).toBe('OVERFLOW');
    expect(reasonOf(() => toBalance(1.5 as never))).toBe('INVALID');
    expect(reasonOf(() => formatBalance((2n ** 63n) as unknown as Balance))).toBe('INVALID');
  });

  it('TC-22-12 an error message never repeats the input it refused', () => {
    const hostile = '-zz-secret-'.padEnd(40, 'x');
    let message = '';
    try {
      parseBalance(hostile);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('secret');
  });

  it('TC-22-17 the compiler keeps number, bare bigint, Money and Balance apart', () => {
    // Nothing here runs. Each `@ts-expect-error` line must be a compile error: if the types were
    // loosened, the directive would be unused and `npm run typecheck` / ts-jest would fail.
    const _typeChecks = (): void => {
      const aBalance = balance('1');
      const aMoney = money('1');

      // @ts-expect-error -- a bare bigint literal is not a Money
      const _m1: Money = 1n;
      // @ts-expect-error -- a number is not a Money
      const _m2: Money = 1;
      // @ts-expect-error -- a bare bigint literal is not a Balance
      const _b1: Balance = 1n;
      // @ts-expect-error -- amounts are Money, never number
      addMoney(1, 2);
      // @ts-expect-error -- a bare bigint is not a Money
      formatMoney(5n);
      // @ts-expect-error -- a Balance is not a Money
      formatMoney(aBalance);
      // @ts-expect-error -- the first argument of creditBalance is a Balance
      creditBalance(aMoney, aMoney);
      // @ts-expect-error -- the amount of debitBalance is a Money, not a Balance
      debitBalance(aBalance, aBalance);
      // @ts-expect-error -- two different brands cannot be compared with ===
      void (aMoney === aBalance);

      // What IS allowed: relational operators between the two, and widening first for equality.
      void (aBalance < aMoney);
      void ((aMoney as bigint) === aBalance);
    };
    expect(typeof _typeChecks).toBe('function');
  });
});
