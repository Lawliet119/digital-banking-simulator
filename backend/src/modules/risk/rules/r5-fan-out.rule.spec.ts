import type { Features, TransferEvent } from '../features/feature-provider';
import type { RiskRule, RuleParams } from './rule';
import { R5FanOutRule } from './r5-fan-out.rule';

const event: TransferEvent = {
  eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
  eventType: 'TransferCompleted',
  occurredAt: '2026-10-19T03:15:42.123Z',
  correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
  transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
  type: 'TRANSFER',
  fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
  toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  amount: '200000',
  fromBalanceBefore: '5000000',
  fromAccountCreatedAt: '2026-09-30T08:00:00.000Z',
  toAccountCreatedAt: '2026-01-15T08:00:00.000Z',
  sameOwner: false,
  fromUserId: 'b2e5c8a1-6f40-4d93-8c17-a9d3f0e6b724',
  toUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
};
const features: Features = {
  txCount10m: 1,
  txCount1h: 5,
  historyCount30d: 10,
  medianAmount30dTimes2: '400000',
  reverseTransferOccurredAt: null,
  newRecipients1h: 5,
  distinctRecipients24h: 12,
  sumOut24h: '1000000',
  smallTxCount24h: 0,
};
const params: RuleParams = {
  enabled: true,
  weight: 40,
  thresholds: { minNewRecipients: 5, windowMinutes: 60, noveltyDays: 30 },
};
const rule: RiskRule = new R5FanOutRule();

describe('DBS-106 R5 fan-out', () => {
  // Novelty and event-time window extraction belong to the provider, not this suite.
  it.each([0, 4])('does not hit for %s new recipients', newRecipients1h => {
    expect(rule.evaluate(event, { ...features, newRecipients1h }, params)).toBeNull();
  });

  it.each([5, 6])('hits inclusively for %s new recipients', newRecipients1h => {
    expect(rule.evaluate(event, { ...features, newRecipients1h }, params)).toMatchObject({
      id: 'R5',
      weight: 40,
    });
  });

  it('explains the observed count and configured threshold', () => {
    const hit = rule.evaluate(event, { ...features, newRecipients1h: 8 }, params);
    expect(hit?.explanation).toContain('8');
    expect(hit?.explanation).toContain('5');
  });

  it('uses the configured inclusive minimum and weight', () => {
    const configured: RuleParams = {
      ...params,
      weight: 17,
      thresholds: { ...params.thresholds, minNewRecipients: 7 },
    };
    expect(rule.evaluate(event, { ...features, newRecipients1h: 6 }, configured)).toBeNull();
    const hit = rule.evaluate(event, { ...features, newRecipients1h: 7 }, configured);
    expect(hit).toMatchObject({ id: 'R5', weight: 17 });
    expect(hit?.explanation).toContain('7');
  });

  it('unconditionally exempts transfers between the same owner accounts', () => {
    expect(
      rule.evaluate({ ...event, sameOwner: true }, { ...features, newRecipients1h: 100 }, params),
    ).toBeNull();
  });

  it('does not mistake total recipients for new recipients', () => {
    expect(
      rule.evaluate(event, { ...features, newRecipients1h: 4, distinctRecipients24h: 100 }, params),
    ).toBeNull();
  });

  it('returns null when disabled even when the trigger is present', () => {
    expect(rule.evaluate(event, features, { ...params, enabled: false })).toBeNull();
  });

  // BL-207(a): a switched-off rule judges only its configuration, never the provider's data.
  it.each([undefined, null, '5', -1, 1.5, NaN, Infinity])(
    'returns null when disabled even with a bad recipient count %s',
    newRecipients1h => {
      expect(
        rule.evaluate(event, { ...features, newRecipients1h } as unknown as Features, {
          ...params,
          enabled: false,
        }),
      ).toBeNull();
    },
  );

  it('returns null when disabled even with a malformed sameOwner snapshot', () => {
    expect(
      rule.evaluate({ ...event, sameOwner: 'x' } as unknown as TransferEvent, features, {
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
        thresholds: { ...params.thresholds, minNewRecipients: 0 },
      }),
    ).toThrow('Invalid R5 configuration');
  });

  it.each([undefined, null, 'false', 0, 1])('rejects malformed sameOwner %s', sameOwner => {
    expect(() =>
      rule.evaluate({ ...event, sameOwner } as unknown as TransferEvent, features, params),
    ).toThrow();
  });

  it.each([undefined, null, '5', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid recipient count %s rather than classifying',
    newRecipients1h => {
      expect(() =>
        rule.evaluate(event, { ...features, newRecipients1h } as unknown as Features, params),
      ).toThrow();
    },
  );

  it.each([
    { ...params, enabled: 'yes' },
    { ...params, weight: -1 },
    { ...params, weight: NaN },
    { ...params, weight: 1.5 },
    { ...params, weight: 2147483648 },
    { ...params, thresholds: {} },
    ...[0, -1, 1.5, NaN, Infinity, '5', Number.MAX_SAFE_INTEGER + 1].map(minNewRecipients => ({
      ...params,
      thresholds: { ...params.thresholds, minNewRecipients },
    })),
    { ...params, thresholds: { ...params.thresholds, windowMinutes: 59 } },
    { ...params, thresholds: { ...params.thresholds, noveltyDays: 29 } },
  ])('rejects invalid rule configuration', badParams => {
    expect(() => rule.evaluate(event, features, badParams as unknown as RuleParams)).toThrow();
  });

  it('is deterministic and leaves its inputs unchanged', () => {
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
