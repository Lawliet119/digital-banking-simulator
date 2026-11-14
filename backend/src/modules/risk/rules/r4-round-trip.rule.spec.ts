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
    ['2026-10-18T12:00:00.000Z', false],
  ])('uses the half-open historical interval for %s', (reverseTransferOccurredAt, hits) => {
    expect(rule.evaluate(event, { ...features, reverseTransferOccurredAt }, params) !== null).toBe(
      hits,
    );
  });

  // BL-207(b): the provider only returns transfers strictly before the event, so a reverse fact at
  // or after occurredAt is a provider fault. It fails closed (ADR-14: a feature fault rolls back and
  // retries), exactly like the AI projection does; it is never silently scored as "no reverse".
  it.each([
    ['at the same instant', '2026-10-19T12:00:00.000Z'],
    ['one millisecond after', '2026-10-19T12:00:00.001Z'],
    ['a day after', '2026-10-20T12:00:00.000Z'],
  ])('throws when the reverse transfer is %s the event', (_name, reverseTransferOccurredAt) => {
    expect(() => rule.evaluate(event, { ...features, reverseTransferOccurredAt }, params)).toThrow(
      'Invalid R4 reverse timestamp',
    );
  });

  it('BL-207(c) compares at the resolution of the timestamps it receives (ms from the provider)', () => {
    // The provider cuts both instants to milliseconds, so the smallest elapsed it can hand over is 1 ms.
    const hit = rule.evaluate(
      event,
      { ...features, reverseTransferOccurredAt: '2026-10-19T11:59:59.999Z' },
      params,
    );
    expect(hit?.explanation).toBe('Tài khoản đích đã chuyển ngược lại chưa đến 0,01 phút trước.');
  });

  it.each([
    ['2026-10-19T11:45:00.000Z', 'khoảng 15,00'],
    ['2026-10-19T11:59:59.999Z', 'chưa đến 0,01'],
    ['2026-10-19T11:00:00.000Z', 'khoảng 60,00'],
    ['2026-10-19T11:30:30.500Z', 'khoảng 29,49'],
  ])('explains a reverse transfer at %s as %s minutes, rounded down', (reverse, text) => {
    const hit = rule.evaluate(event, { ...features, reverseTransferOccurredAt: reverse }, params);
    expect(hit?.explanation).toBe(`Tài khoản đích đã chuyển ngược lại ${text} phút trước.`);
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

  // BL-207(a): a switched-off rule judges only its configuration (R3 policy), so disabling R4 in a
  // new rule-set version rescues the consumer from a provider that emits bad data.
  it.each([
    ['an unparsable reverse timestamp', { reverseTransferOccurredAt: 'not-a-date' }, {}],
    ['a non-string reverse timestamp', { reverseTransferOccurredAt: 5 }, {}],
    [
      'a reverse transfer after the event',
      { reverseTransferOccurredAt: '2026-10-20T00:00:00Z' },
      {},
    ],
    ['an unparsable occurredAt', {}, { occurredAt: 'garbage' }],
  ])('returns null when disabled even with %s', (_name, featureFields, eventFields) => {
    expect(
      rule.evaluate(
        { ...event, ...eventFields },
        { ...features, ...featureFields } as unknown as Features,
        { ...params, enabled: false },
      ),
    ).toBeNull();
  });

  it('still rejects a bad configuration when disabled', () => {
    expect(() =>
      rule.evaluate(event, features, {
        ...params,
        enabled: false,
        thresholds: { reverseWindowMinutes: 61 },
      }),
    ).toThrow('Invalid R4 configuration');
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

  // BL-212 (DBS-105 review #4): the upper bound of the window is 60 minutes. 61 is refused when
  // the rule is enabled, and a reverse transfer 61 minutes back is not a round trip at 60.
  it('rejects a reverseWindowMinutes of 61 when enabled, and accepts the bounds 1 and 60', () => {
    expect(() =>
      rule.evaluate(event, features, { ...params, thresholds: { reverseWindowMinutes: 61 } }),
    ).toThrow('Invalid R4 configuration');
    for (const reverseWindowMinutes of [1, 60]) {
      expect(() =>
        rule.evaluate(event, features, { ...params, thresholds: { reverseWindowMinutes } }),
      ).not.toThrow();
    }
  });

  it('a reverse transfer 61 minutes back is outside the 60-minute window, 60 minutes back is inside', () => {
    const back = (reverseTransferOccurredAt: string) =>
      rule.evaluate(event, { ...features, reverseTransferOccurredAt }, params);
    expect(back('2026-10-19T10:59:00.000Z')).toBeNull(); // 61:00.000
    expect(back('2026-10-19T10:59:59.999Z')).toBeNull(); // 60:00.001
    expect(back('2026-10-19T11:00:00.000Z')?.explanation).toBe(
      'Tài khoản đích đã chuyển ngược lại khoảng 60,00 phút trước.',
    );
  });

  it.each([
    { ...params, enabled: 'yes' },
    { ...params, thresholds: { reverseWindowMinutes: 61 } },
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
