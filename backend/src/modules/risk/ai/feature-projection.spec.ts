import { projectFeatures } from './feature-projection';

const valid = {
  amount: '9007199254740993',
  fromBalanceBefore: '9223372036854775807',
  accountAgeHours: 3,
  sameOwner: false,
  txCount10m: 2,
  txCount1h: 3,
  historyCount30d: 6,
  medianAmount30d: '5000000.5',
  minutesSinceReverse: null,
  newRecipients1h: 2,
  distinctRecipients24h: 3,
};

describe('AI feature projection', () => {
  it('preserves exact monetary strings and deterministic field order', () => {
    const reversed = Object.fromEntries(Object.entries(valid).reverse());
    expect(projectFeatures(reversed)).toEqual(valid);
    expect(JSON.stringify(projectFeatures(reversed))).toBe(JSON.stringify(valid));
  });

  it.each([
    ['unexpected ID', { ...valid, accountId: 'private' }],
    ['unexpected email', { ...valid, email: 'private@example.test' }],
    ['leading zero', { ...valid, amount: '01' }],
    ['overflow', { ...valid, amount: '9223372036854775808' }],
    ['negative zero', { ...valid, fromBalanceBefore: '-0' }],
    ['numeric money', { ...valid, amount: 9007199254740992 }],
    ['invalid median', { ...valid, medianAmount30d: '4.2' }],
    ['missing median with history', { ...valid, medianAmount30d: null }],
    ['median without history', { ...valid, historyCount30d: 0 }],
    ['negative count', { ...valid, txCount10m: -1 }],
    ['unsafe count', { ...valid, txCount1h: Number.MAX_SAFE_INTEGER + 1 }],
    ['nan age', { ...valid, accountAgeHours: NaN }],
    ['missing boolean', { ...valid, sameOwner: undefined }],
  ])('rejects %s without disclosing input', (_name, value) => {
    expect(() => projectFeatures(value)).toThrow('Invalid AI features');
  });

  it('allows no history with null median and preserves zero fields', () => {
    const input = { ...valid, historyCount30d: 0, medianAmount30d: null, accountAgeHours: 0 };
    expect(projectFeatures(input)).toEqual(input);
  });
});
