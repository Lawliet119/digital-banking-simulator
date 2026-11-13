import type { Features, TransferEvent } from '../features/feature-provider';
import type { RiskRule, RuleParams } from './rule';
import { R6DrainRule } from './r6-drain.rule';

const event: TransferEvent = {
  eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
  eventType: 'TransferCompleted',
  occurredAt: '2026-10-19T03:15:42.123Z',
  correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
  transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
  type: 'TRANSFER',
  fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
  toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  amount: '900000',
  fromBalanceBefore: '1000000',
  fromAccountCreatedAt: '2026-09-30T08:00:00.000Z',
  toAccountCreatedAt: '2026-01-15T08:00:00.000Z',
  sameOwner: false,
  fromUserId: 'b2e5c8a1-6f40-4d93-8c17-a9d3f0e6b724',
  toUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
};
const features: Features = {
  txCount10m: 1,
  txCount1h: 1,
  historyCount30d: 5,
  medianAmount30dTimes2: '1800000',
  reverseTransferOccurredAt: null,
  newRecipients1h: 1,
  distinctRecipients24h: 1,
  sumOut24h: '900000',
  smallTxCount24h: 0,
};
const params: RuleParams = {
  enabled: true,
  weight: 30,
  thresholds: { minBalancePercent: 90, minBalance: '1000000' },
};
const rule: RiskRule = new R6DrainRule();

describe('DBS-107 R6 drain', () => {
  it('uses inclusive 90 percent and one-million balance boundaries', () => {
    expect(rule.evaluate(event, features, params)).toMatchObject({ id: 'R6', weight: 30 });
    expect(rule.evaluate({ ...event, amount: '899999' }, features, params)).toBeNull();
  });

  it('requires the balance minimum even for a complete drain', () => {
    expect(
      rule.evaluate({ ...event, amount: '999999', fromBalanceBefore: '999999' }, features, params),
    ).toBeNull();
    expect(rule.evaluate({ ...event, amount: '1000000' }, features, params)).toMatchObject({
      id: 'R6',
    });
  });

  it.each(['0', '-1', '-9223372036854775808'])(
    'does not trigger on valid nonpositive balance snapshot %s',
    fromBalanceBefore => {
      expect(rule.evaluate({ ...event, fromBalanceBefore }, features, params)).toBeNull();
    },
  );

  it('compares extreme bigint money exactly, including one dong below 90 percent', () => {
    const balance = 9223372036854775800n;
    const exact = (balance * 9n) / 10n;
    const input = { ...event, fromBalanceBefore: balance.toString() };
    expect(
      rule.evaluate({ ...input, amount: (exact - 1n).toString() }, features, params),
    ).toBeNull();
    expect(rule.evaluate({ ...input, amount: exact.toString() }, features, params)).toMatchObject({
      id: 'R6',
    });
  });

  it('uses an exact cross-product when 90 percent is a fractional dong', () => {
    const input = { ...event, fromBalanceBefore: '1000001' };
    expect(rule.evaluate({ ...input, amount: '900000' }, features, params)).toBeNull();
    expect(rule.evaluate({ ...input, amount: '900001' }, features, params)).toMatchObject({
      id: 'R6',
    });
  });

  it('BL-184 H7 explains the percentage and snapshot amounts in the shared money format', () => {
    const hit = rule.evaluate({ ...event, amount: '950000' }, features, params);
    expect(hit?.explanation).toBe('Chuyển xấp xỉ 95,00% số dư (950.000đ/1.000.000đ).');
  });

  // BL-207(d): the percentage is shown rounded down, so it never overstates the drain.
  it.each([
    ['99996', '100000', '99,99'],
    ['999999', '1000000', '99,99'],
    ['1000000', '1000000', '100,00'],
    ['900000', '1000000', '90,00'],
    ['900001', '1000001', '90,00'],
    ['9', '10', '90,00'],
  ])('rounds %s of %s down to %s%%', (amount, balance, percent) => {
    const hit = rule.evaluate(
      { ...event, amount, fromBalanceBefore: balance },
      features,
      // minBalance 1: the small balances below are only there to exercise the percentage text.
      { ...params, thresholds: { minBalancePercent: 90, minBalance: '1' } },
    );
    expect(hit?.explanation).toContain(`xấp xỉ ${percent}% số dư`);
  });

  it('formats the largest balance without losing digits', () => {
    const hit = rule.evaluate(
      { ...event, amount: '9223372036854775807', fromBalanceBefore: '9223372036854775807' },
      features,
      params,
    );
    expect(hit?.explanation).toBe(
      'Chuyển xấp xỉ 100,00% số dư (9.223.372.036.854.775.807đ/9.223.372.036.854.775.807đ).',
    );
  });

  it('uses the configured percent, minimum balance and weight', () => {
    const configured: RuleParams = {
      enabled: true,
      weight: 17,
      thresholds: { minBalancePercent: 95, minBalance: '2000000' },
    };
    expect(
      rule.evaluate(
        { ...event, amount: '1900000', fromBalanceBefore: '2000000' },
        features,
        configured,
      ),
    ).toMatchObject({ id: 'R6', weight: 17 });
    expect(
      rule.evaluate(
        { ...event, amount: '1899999', fromBalanceBefore: '2000000' },
        features,
        configured,
      ),
    ).toBeNull();
    expect(rule.evaluate({ ...event, amount: '1000000' }, features, configured)).toBeNull();
  });

  it('uses the event snapshot, not unrelated aggregate outgoing money', () => {
    expect(
      rule.evaluate(
        { ...event, amount: '899999' },
        { ...features, sumOut24h: '9223372036854775807' },
        params,
      ),
    ).toBeNull();
    expect(rule.evaluate(event, { ...features, sumOut24h: '1' }, params)).toMatchObject({
      id: 'R6',
    });
  });

  it('unconditionally exempts transfers between the same owner accounts', () => {
    expect(
      rule.evaluate({ ...event, sameOwner: true, amount: '1000000' }, features, params),
    ).toBeNull();
  });

  it('returns null when disabled even when the trigger is present', () => {
    expect(rule.evaluate(event, features, { ...params, enabled: false })).toBeNull();
  });

  // BL-207(a): a switched-off rule judges only its configuration, never the event snapshot.
  it.each([
    ['sameOwner', { sameOwner: 'x' }],
    ['balance snapshot', { fromBalanceBefore: 'x' }],
    ['amount', { amount: '0' }],
  ])('returns null when disabled even with a malformed %s', (_name, fields) => {
    expect(
      rule.evaluate({ ...event, ...fields } as unknown as TransferEvent, features, {
        ...params,
        enabled: false,
      }),
    ).toBeNull();
  });

  it('still rejects a bad configuration when disabled', () => {
    expect(() =>
      rule.evaluate(event, features, {
        ...params,
        enabled: false,
        thresholds: { minBalancePercent: 0, minBalance: '1000000' },
      }),
    ).toThrow('Invalid R6 configuration');
  });

  it.each([undefined, null, 'false', 0, 1])('rejects malformed sameOwner %s', sameOwner => {
    expect(() =>
      rule.evaluate({ ...event, sameOwner } as unknown as TransferEvent, features, params),
    ).toThrow();
  });

  it.each([
    undefined,
    null,
    1000000,
    '',
    '01',
    '-0',
    '1.0',
    '1e6',
    ' 1000000',
    '9223372036854775808',
    '-9223372036854775809',
  ])('rejects malformed balance snapshot %s', fromBalanceBefore => {
    expect(() =>
      rule.evaluate({ ...event, fromBalanceBefore } as unknown as TransferEvent, features, params),
    ).toThrow();
  });

  it.each([undefined, null, 900000, '0', '-1', '01', '1.0', '1e6', '9223372036854775808'])(
    'rejects malformed transfer money %s',
    amount => {
      expect(() =>
        rule.evaluate({ ...event, amount } as unknown as TransferEvent, features, params),
      ).toThrow();
    },
  );

  it.each([
    { ...params, enabled: 'yes' },
    ...[-1, NaN, Infinity, 1.5, 2147483648].map(weight => ({ ...params, weight })),
    { ...params, thresholds: {} },
    ...[0, -1, 101, 90.5, NaN, Infinity, '90'].map(minBalancePercent => ({
      ...params,
      thresholds: { ...params.thresholds, minBalancePercent },
    })),
    ...['0', '-1', '01', '1.5', '9223372036854775808', 1000000].map(minBalance => ({
      ...params,
      thresholds: { ...params.thresholds, minBalance },
    })),
  ])('rejects invalid configuration rather than silently classifying', badParams => {
    expect(() => rule.evaluate(event, features, badParams as unknown as RuleParams)).toThrow();
  });

  it('is deterministic and leaves frozen inputs unchanged', () => {
    const input = Object.freeze({ ...event });
    const facts = Object.freeze({ ...features });
    const config = Object.freeze({
      ...params,
      thresholds: Object.freeze({ ...params.thresholds }),
    });
    const first = rule.evaluate(input, facts, config);
    expect(rule.evaluate(input, facts, config)).toEqual(first);
    expect(input).toEqual(event);
    expect(facts).toEqual(features);
    expect(config).toEqual(params);
  });
});
