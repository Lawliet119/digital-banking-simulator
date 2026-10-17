import { MONEY_ACCEPT, MONEY_REJECT, NON_STRING_INPUTS } from '../../../test/support/money-cases';
import {
  MONEY_MAX,
  MONEY_ZERO,
  MoneyError,
  addMoney,
  formatMoney,
  parseMoney,
  parsePositiveMoney,
  subtractMoney,
  toMoney,
  tryParseMoney,
  type Money,
} from './money';

/** What `MoneyError.reason` says when `fn` throws, or `'NO_ERROR'` when it does not. */
function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof MoneyError) return error.reason;
    throw error;
  }
  return 'NO_ERROR';
}

const money = (digits: string): Money => parseMoney(digits);

describe('Money (DBS-22)', () => {
  it('TC-22-01 parses canonical strings to the exact bigint', () => {
    for (const [text, value] of MONEY_ACCEPT) {
      expect(parseMoney(text)).toBe(value);
    }
  });

  it('TC-22-02 keeps 2^53 + 1 and 2^63 - 1 exact through parse and format', () => {
    for (const text of ['9007199254740993', '9223372036854775807']) {
      const parsed = parseMoney(text);
      expect(parsed).toBe(BigInt(text));
      expect(formatMoney(parsed)).toBe(text);
      // The reason this library exists: a JS number silently drops the last digit.
      if (text === '9007199254740993') expect(String(Number(text))).not.toBe(text);
    }
  });

  it('TC-22-03 format(parse(s)) is s around every power of ten and every float boundary', () => {
    const samples = new Set<string>([
      (2n ** 53n - 1n).toString(),
      (2n ** 53n).toString(),
      (2n ** 53n + 1n).toString(),
      MONEY_MAX.toString(),
    ]);
    for (let k = 0; k <= 18; k += 1) {
      const power = 10n ** BigInt(k);
      samples.add((power - 1n).toString());
      samples.add(power.toString());
      samples.add((power + 1n).toString());
    }
    for (const text of samples) {
      expect(formatMoney(parseMoney(text))).toBe(text);
    }
  });

  it.each(MONEY_REJECT.filter(c => c.reason === 'INVALID'))(
    'TC-22-04 refuses %j as INVALID',
    ({ input }) => {
      expect(reasonOf(() => parseMoney(input))).toBe('INVALID');
    },
  );

  it.each(MONEY_REJECT.filter(c => c.reason === 'OVERFLOW'))(
    'TC-22-05 refuses a %# value above 2^63 - 1 as OVERFLOW',
    ({ input }) => {
      expect(reasonOf(() => parseMoney(input))).toBe('OVERFLOW');
    },
  );

  it('TC-22-06 refuses everything that is not a string', () => {
    for (const input of NON_STRING_INPUTS) {
      expect(reasonOf(() => parseMoney(input as string))).toBe('INVALID');
    }
  });

  it('TC-22-07 tryParseMoney gives the same decisions, as null instead of a throw', () => {
    for (const { input } of MONEY_REJECT) expect(tryParseMoney(input)).toBeNull();
    for (const input of NON_STRING_INPUTS) expect(tryParseMoney(input)).toBeNull();
    for (const [text, value] of MONEY_ACCEPT) expect(tryParseMoney(text)).toBe(value);
  });

  it('TC-22-08 parsePositiveMoney refuses zero, and keeps the reasons of parseMoney', () => {
    expect(parsePositiveMoney('1')).toBe(1n);
    expect(parsePositiveMoney('9223372036854775807')).toBe(MONEY_MAX);
    expect(reasonOf(() => parsePositiveMoney('0'))).toBe('NOT_POSITIVE');
    for (const { input, reason } of MONEY_REJECT) {
      expect(reasonOf(() => parsePositiveMoney(input))).toBe(reason);
    }
    for (const input of NON_STRING_INPUTS) {
      expect(reasonOf(() => parsePositiveMoney(input as string))).toBe('INVALID');
    }
  });

  it('TC-22-09 addMoney is exact above 2^53 and refuses to pass 2^63 - 1', () => {
    expect(addMoney(money('9007199254740992'), money('1'))).toBe(9_007_199_254_740_993n);
    expect(addMoney(money('9223372036854775806'), money('1'))).toBe(MONEY_MAX);
    expect(addMoney(MONEY_MAX, MONEY_ZERO)).toBe(MONEY_MAX);
    expect(reasonOf(() => addMoney(MONEY_MAX, money('1')))).toBe('OVERFLOW');
  });

  it('TC-22-10 subtractMoney is exact and never produces a negative Money', () => {
    expect(subtractMoney(money('9007199254740993'), money('1'))).toBe(9_007_199_254_740_992n);
    expect(subtractMoney(money('300000'), money('300000'))).toBe(0n);
    expect(reasonOf(() => subtractMoney(MONEY_ZERO, money('1')))).toBe('UNDERFLOW');
    expect(reasonOf(() => subtractMoney(money('5'), money('6')))).toBe('UNDERFLOW');
  });

  it('TC-22-11 toMoney checks a computed bigint; formatMoney refuses a forged one', () => {
    expect(toMoney(0n)).toBe(0n);
    expect(toMoney(2n ** 63n - 1n)).toBe(MONEY_MAX);
    expect(reasonOf(() => toMoney(-1n))).toBe('INVALID');
    expect(reasonOf(() => toMoney(1.5 as never))).toBe('INVALID');
    // Same value as parseMoney('9223372036854775808'): same reason.
    expect(reasonOf(() => toMoney(2n ** 63n))).toBe('OVERFLOW');
    expect(reasonOf(() => formatMoney(-5n as unknown as Money))).toBe('INVALID');
    expect(reasonOf(() => formatMoney((2n ** 63n) as unknown as Money))).toBe('INVALID');
  });

  it('TC-22-12 an error message never repeats the input it refused', () => {
    const hostile = 'zz-secret-'.padEnd(40, 'x');
    let message = '';
    try {
      parseMoney(hostile);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('secret');
    expect(message).not.toContain(hostile);
  });
});
