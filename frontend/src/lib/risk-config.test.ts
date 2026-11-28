import { describe, expect, it } from 'vitest';
import { parseConfig, readRules, readThresholds, withWeight } from './risk-config';

const CONFIG = {
  thresholds: { medium: 40, high: 70 },
  rules: { R1: { enabled: true, weight: 30, maxTransfers: 5 }, R2: { weight: 'x' } },
};

describe('risk configuration view', () => {
  it('draws only the rules that have the two shown fields', () => {
    expect(readRules(CONFIG)).toEqual([{ id: 'R1', enabled: true, weight: 30 }]);
    expect(readRules(null)).toEqual([]);
    expect(readRules({ rules: [] })).toEqual([]);
  });

  it('reads the thresholds only when both are numbers', () => {
    expect(readThresholds(CONFIG)).toEqual({ medium: 40, high: 70 });
    expect(readThresholds({ thresholds: { medium: 40 } })).toBeUndefined();
  });

  it('accepts only a JSON object as configuration text', () => {
    expect(parseConfig('{"a":1}')).toEqual({ a: 1 });
    expect(parseConfig('[1]')).toBeUndefined();
    expect(parseConfig('{')).toBeUndefined();
  });

  it('changes one weight and keeps every other field', () => {
    const next = parseConfig(withWeight(JSON.stringify(CONFIG), 'R1', 45));
    expect(next).toEqual({
      ...CONFIG,
      rules: { ...CONFIG.rules, R1: { enabled: true, weight: 45, maxTransfers: 5 } },
    });
    expect(withWeight('not json', 'R1', 45)).toBe('not json');
    expect(withWeight('{}', 'R1', 45)).toBe('{}');
  });
});
