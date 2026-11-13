import { MONEY_MAX } from '@common/money';
import {
  formatDong,
  formatDongHalf,
  formatFixed2,
  formatTrimmed2,
  groupThousands,
} from './explanation-format';

describe('BL-184 H7 / BL-207(e) explanation formatter', () => {
  it.each([
    [0n, '0đ'],
    [999n, '999đ'],
    [1_000n, '1.000đ'],
    [20_000_000n, '20.000.000đ'],
    [BigInt(MONEY_MAX), '9.223.372.036.854.775.807đ'],
  ])('formats %s dong with dot-grouped thousands and the đ suffix', (amount, text) => {
    expect(formatDong(amount)).toBe(text);
  });

  it.each([
    [2n, '1đ'],
    [3n, '1,5đ'],
    [2_000_001n, '1.000.000,5đ'],
    [2n * BigInt(MONEY_MAX), '9.223.372.036.854.775.807đ'],
  ])('formats a doubled median %s with a decimal comma only for a half', (twice, text) => {
    expect(formatDongHalf(twice)).toBe(text);
  });

  it.each([
    [0n, '0,00'],
    [1n, '0,01'],
    [9_999n, '99,99'],
    [10_000n, '100,00'],
    [123_456_789n, '1.234.567,89'],
  ])('formats %s hundredths with two decimals', (hundredths, text) => {
    expect(formatFixed2(hundredths)).toBe(text);
  });

  it.each([
    [500n, '5'],
    [1_250n, '12,5'],
    [501n, '5,01'],
    [100_000n, '1.000'],
  ])('formats %s hundredths without trailing zeros', (hundredths, text) => {
    expect(formatTrimmed2(hundredths)).toBe(text);
  });

  it('groups a digit string without going through Number', () => {
    expect(groupThousands('9223372036854775807')).toBe('9.223.372.036.854.775.807');
    expect(groupThousands('12')).toBe('12');
  });
});
