import type { Features, TransferEvent } from '../features/feature-provider';
import type { RuleParams } from './rule';
import { R4RoundTripRule } from './r4-round-trip.rule';

const event: TransferEvent = {
  eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
  eventType: 'TransferCompleted',
  occurredAt: '2026-10-19T12:00:00.000Z',
  correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
  transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
  type: 'TRANSFER',
  fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
  toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  amount: '2000000',
  fromBalanceBefore: '5000000',
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
  medianAmount30dTimes2: '2000000',
  reverseTransferOccurredAt: '2026-10-19T11:45:00.000Z',
  newRecipients1h: 1,
  distinctRecipients24h: 1,
  sumOut24h: '2000000',
  smallTxCount24h: 0,
};
const params: RuleParams = {
  enabled: true,
  weight: 20,
  thresholds: { reverseWindowMinutes: 60 },
};
const rule = new R4RoundTripRule();

// The feature provider, not this pure rule, selects completed reverse TRANSFERs.
describe('DBS-105 R4 round trip', () => {
  it('flags a reverse transfer fifteen minutes before the event and explains elapsed minutes', () => {
    const hit = rule.evaluate(event, features, params);
    expect(hit).toMatchObject({ id: 'R4', weight: 20 });
    expect(hit?.explanation).toContain('15');
    expect(hit?.explanation).toMatch(/phút|minute/i);
  });

  it.each([
    ['2026-10-19T11:00:00.000Z', true],
    ['2026-10-19T10:59:59.999Z', false],
    ['2026-10-19T11:00:00.001Z', true],
    ['2026-10-19T11:59:59.999Z', true],
    ['2026-10-19T12:00:00.000Z', false],
    ['2026-10-19T12:00:00.001Z', false],
    ['2026-10-18T12:00:00.000Z', false],
  ])('uses the half-open historical interval for %s', (reverseTransferOccurredAt, hits) => {
    expect(rule.evaluate(event, { ...features, reverseTransferOccurredAt }, params) !== null).toBe(
      hits,
    );
  });

  it('preserves sub-millisecond ordering at both ends of the reverse window', () => {
    const preciseEvent = { ...event, occurredAt: '2026-10-19T12:00:00.000000001Z' };
    expect(
      rule.evaluate(
        preciseEvent,
        { ...features, reverseTransferOccurredAt: '2026-10-19T12:00:00.000000000Z' },
        params,
      ),
    ).toMatchObject({ id: 'R4' });
    expect(
      rule.evaluate(
        preciseEvent,
        { ...features, reverseTransferOccurredAt: '2026-10-19T11:00:00.000000000Z' },
        params,
      ),
    ).toBeNull();
    expect(
      rule.evaluate(
        preciseEvent,
        { ...features, reverseTransferOccurredAt: '2026-10-19T11:00:00.000000001Z' },
        params,
      ),
    ).toMatchObject({ id: 'R4' });
  });

  it('returns null when no reverse transfer was found', () => {
    expect(
      rule.evaluate(event, { ...features, reverseTransferOccurredAt: null }, params),
    ).toBeNull();
  });

  it('honors a configured shorter window and configured weight', () => {
    const configured: RuleParams = {
      enabled: true,
      weight: 7,
      thresholds: { reverseWindowMinutes: 10 },
    };
    expect(rule.evaluate(event, features, configured)).toBeNull();
    expect(
      rule.evaluate(
        event,
        { ...features, reverseTransferOccurredAt: '2026-10-19T11:50:00.000Z' },
        configured,
      ),
    ).toMatchObject({ id: 'R4', weight: 7 });
    expect(
      rule.evaluate(
        event,
        { ...features, reverseTransferOccurredAt: '2026-10-19T11:49:59.999Z' },
        configured,
      ),
    ).toBeNull();
  });

  it('does not exempt transfers between accounts of the same owner', () => {
    expect(
      rule.evaluate({ ...event, sameOwner: true, toUserId: event.fromUserId }, features, params),
    ).toMatchObject({ id: 'R4' });
  });

  it('is deterministic and leaves the event, feature and configuration snapshots unchanged', () => {
    const inputEvent = Object.freeze({ ...event });
    const inputFeatures = Object.freeze({ ...features });
    const inputParams = Object.freeze({
      ...params,
      thresholds: Object.freeze({ ...params.thresholds }),
    });
    expect(rule.evaluate(inputEvent, inputFeatures, inputParams)).toEqual(
      rule.evaluate(inputEvent, inputFeatures, inputParams),
    );
    expect(inputEvent).toEqual(event);
    expect(inputFeatures).toEqual(features);
    expect(inputParams).toEqual(params);
  });

  it('returns null when disabled', () => {
    expect(rule.evaluate(event, features, { ...params, enabled: false })).toBeNull();
  });

  it.each(['', 'not-a-date', undefined])('rejects an invalid reverse timestamp %s', value => {
    expect(() =>
      rule.evaluate(
        event,
        { ...features, reverseTransferOccurredAt: value } as unknown as Features,
        params,
      ),
    ).toThrow();
  });

  it.each(['', 'not-a-date', undefined, null])('rejects invalid event timestamp %s', value => {
    expect(() =>
      rule.evaluate({ ...event, occurredAt: value } as unknown as TransferEvent, features, params),
    ).toThrow();
  });

  it.each([
    { ...params, enabled: 'yes' },
    { ...params, weight: -1 },
    { ...params, weight: 0.5 },
    { ...params, weight: 2147483648 },
    { ...params, thresholds: {} },
    { ...params, thresholds: { reverseWindowMinutes: 0 } },
    { ...params, thresholds: { reverseWindowMinutes: -1 } },
    { ...params, thresholds: { reverseWindowMinutes: Number.NaN } },
    { ...params, thresholds: { reverseWindowMinutes: Number.POSITIVE_INFINITY } },
    { ...params, thresholds: { reverseWindowMinutes: 'invalid' } },
  ])('rejects invalid configuration', input => {
    expect(() => rule.evaluate(event, features, input as unknown as RuleParams)).toThrow();
  });
});
