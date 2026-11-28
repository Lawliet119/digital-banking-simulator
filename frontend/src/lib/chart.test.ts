import { describe, expect, it } from 'vitest';
import { stepPath } from './chart';

describe('stepPath', () => {
  it('is empty without data', () => {
    expect(stepPath([], 100, 50)).toBe('');
  });

  it('puts the largest balance near the top and zero at the bottom', () => {
    expect(stepPath(['0', '100'], 100, 108)).toBe('M0 108 H50 V8 H100');
  });

  it('draws a flat line at the bottom when every balance is zero', () => {
    expect(stepPath(['0', '0'], 10, 20)).toBe('M0 20 H5 V20 H10');
  });

  it('keeps the proportion for balances above 2^53', () => {
    expect(stepPath(['9007199254740993', '18014398509481986'], 100, 108)).toBe('M0 58 H50 V8 H100');
  });
});
