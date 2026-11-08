import type { Features, TransferEvent } from '../features/feature-provider';
import type { RuleParams } from './rule';
import { R1VelocityRule } from './r1-velocity.rule';

const event: TransferEvent = {
  eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
  eventType: 'TransferCompleted',
  occurredAt: '2026-10-19T03:15:42.123Z',
  correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
  transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
  type: 'TRANSFER',
  fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
  toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  amount: '500000',
  fromBalanceBefore: '520000',
  fromAccountCreatedAt: '2026-09-30T08:00:00.000Z',
  toAccountCreatedAt: '2026-01-15T08:00:00.000Z',
  sameOwner: false,
  fromUserId: 'b2e5c8a1-6f40-4d93-8c17-a9d3f0e6b724',
  toUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
};

const features: Features = {
  txCount10m: 6,
  txCount1h: 6,
  historyCount30d: 0,
  medianAmount30dTimes2: null,
  reverseTransferOccurredAt: null,
  newRecipients1h: 1,
  distinctRecipients24h: 1,
  sumOut24h: '500000',
  smallTxCount24h: 1,
};

const params: RuleParams = {
  enabled: true,
  weight: 30,
  thresholds: { maxTransfers: 5, windowMinutes: 10 },
};

const withCount = (txCount10m: number): Features => ({ ...features, txCount10m });

describe('DBS-93 R1 velocity', () => {
  const rule = new R1VelocityRule();

  it('TC-93-01 triggers strictly above the configured threshold and explains the count', () => {
    expect(rule.evaluate(event, withCount(5), params)).toBeNull();
    const hit = rule.evaluate(event, withCount(6), params);
    expect(hit).toEqual({ id: 'R1', weight: 30, explanation: expect.any(String) });
    expect(hit?.explanation).toContain('6');
    expect(hit?.explanation).toContain('10');
    expect(hit?.explanation).toContain('5');
  });

  it('TC-93-02 does not trigger when the rule is disabled', () => {
    expect(rule.evaluate(event, withCount(6), { ...params, enabled: false })).toBeNull();
  });

  it('TC-93-02 uses the versioned threshold and weight instead of the seed values', () => {
    const configured: RuleParams = {
      enabled: true,
      weight: 12,
      thresholds: { maxTransfers: 8, windowMinutes: 10 },
    };
    expect(rule.evaluate(event, withCount(8), configured)).toBeNull();
    expect(rule.evaluate(event, withCount(9), configured)).toMatchObject({
      id: 'R1',
      weight: 12,
    });
  });

  it('TC-93-04 scores only TRANSFER: a DEPOSIT that reaches the rule is never flagged', () => {
    // The type forbids it; the consumer is meant to filter, but the rule must hold on its own
    // when a DEPOSIT slips through at runtime (DoD 3).
    const deposit = { ...event, type: 'DEPOSIT' } as unknown as TransferEvent;
    expect(rule.evaluate(deposit, withCount(6), params)).toBeNull();
    expect(rule.evaluate(deposit, withCount(100), params)).toBeNull();
    expect(rule.evaluate(event, withCount(6), params)).not.toBeNull();
  });

  it('TC-93-04 a DEPOSIT is skipped before the count is read, so a bad count does not fail it', () => {
    const deposit = { ...event, type: 'DEPOSIT' } as unknown as TransferEvent;
    expect(rule.evaluate(deposit, withCount(0), params)).toBeNull();
  });

  it('TC-93-03 accepts the valid zero threshold and a zero rule weight', () => {
    const configured: RuleParams = {
      enabled: true,
      weight: 0,
      thresholds: { maxTransfers: 0, windowMinutes: 10 },
    };
    expect(rule.evaluate(event, withCount(1), configured)).toMatchObject({ id: 'R1', weight: 0 });
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'TC-93-03 rejects invalid feature count %s',
    count => {
      expect(() => rule.evaluate(event, withCount(count), params)).toThrow(Error);
    },
  );

  it.each([
    { ...params, thresholds: { maxTransfers: -1, windowMinutes: 10 } },
    { ...params, enabled: false, thresholds: { maxTransfers: -1, windowMinutes: 10 } },
    { ...params, thresholds: { maxTransfers: 1.5, windowMinutes: 10 } },
    { ...params, thresholds: { maxTransfers: '5', windowMinutes: 10 } },
    { ...params, thresholds: { maxTransfers: Number.MAX_SAFE_INTEGER + 1, windowMinutes: 10 } },
    { ...params, thresholds: { maxTransfers: 5, windowMinutes: 15 } },
    { ...params, thresholds: { maxTransfers: 5 } },
    { ...params, weight: -1 },
    { ...params, weight: 1.5 },
    { ...params, weight: 2147483648 },
    { ...params, weight: NaN },
  ])('TC-93-03 rejects invalid baseline configuration %#', invalid => {
    expect(() => rule.evaluate(event, features, invalid)).toThrow(Error);
  });
});
