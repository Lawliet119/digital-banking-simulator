import { describe, expect, it } from 'vitest';
import { formatVnd, isPositive, parseVndInput } from './money';

describe('formatVnd', () => {
  it('groups thousands with dots', () => {
    expect(formatVnd('1234567')).toBe('1.234.567 ₫');
    expect(formatVnd('100')).toBe('100 ₫');
  });

  it('shows zero', () => {
    expect(formatVnd('0')).toBe('0 ₫');
  });

  it('keeps every digit above 2^53', () => {
    // 2^53 + 1 is not representable as a number: Number() would print ...992.
    expect(formatVnd('9007199254740993')).toBe('9.007.199.254.740.993 ₫');
    expect(formatVnd('-9223372036854775807')).toBe('-9.223.372.036.854.775.807 ₫');
  });

  it('shows a negative balance (the SYSTEM account) with its sign', () => {
    expect(formatVnd('-85000000')).toBe('-85.000.000 ₫');
  });

  it('returns a malformed value unchanged instead of guessing', () => {
    expect(formatVnd('12.5')).toBe('12.5');
    expect(formatVnd('')).toBe('');
  });
});

describe('parseVndInput', () => {
  it('reads plain digits and dot or space separators', () => {
    expect(parseVndInput('2000000')).toBe('2000000');
    expect(parseVndInput('2.000.000')).toBe('2000000');
    expect(parseVndInput(' 2 000 000 ')).toBe('2000000');
  });

  it('keeps every digit above 2^53', () => {
    expect(parseVndInput('9.007.199.254.740.993')).toBe('9007199254740993');
  });

  it('reads zero (the form decides whether zero is allowed)', () => {
    expect(parseVndInput('0')).toBe('0');
    expect(parseVndInput('000')).toBe('0');
  });

  it.each([
    ['empty', ''],
    ['spaces only', '   '],
    ['negative', '-5000'],
    ['a plus sign', '+5000'],
    ['a decimal comma', '1,5'],
    ['a decimal dot', '1.5'],
    ['badly placed separators', '12.34.567'],
    ['letters', '5k'],
    ['exponent', '1e6'],
  ])('refuses %s', (_name, text) => {
    expect(parseVndInput(text)).toBeNull();
  });
});

describe('isPositive', () => {
  it('is true only above zero', () => {
    expect(isPositive('1')).toBe(true);
    expect(isPositive('0')).toBe(false);
    expect(isPositive('-1')).toBe(false);
    expect(isPositive('abc')).toBe(false);
  });
});
