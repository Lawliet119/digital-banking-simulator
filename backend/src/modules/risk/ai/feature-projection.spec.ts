import type { Features, TransferEvent } from '../features/feature-provider';
import { projectFeatures, toAiFeatureInput } from './feature-projection';

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
    ['zero median', { ...valid, medianAmount30d: '0' }],
    ['half-dong zero median', { ...valid, medianAmount30d: '0.5' }],
    ['missing median with >= 5 history', { ...valid, medianAmount30d: null }],
    ['median without history', { ...valid, historyCount30d: 0 }],
    ['negative count', { ...valid, txCount10m: -1 }],
    ['unsafe count', { ...valid, txCount1h: Number.MAX_SAFE_INTEGER + 1 }],
    ['nan age', { ...valid, accountAgeHours: NaN }],
    ['missing boolean', { ...valid, sameOwner: undefined }],
  ])('rejects %s without disclosing input', (_name, value) => {
    expect(() => projectFeatures(value)).toThrow('Invalid AI features');
  });

  it('rejects unexpected own fields even when they are hidden or symbols', () => {
    const hidden = Object.defineProperty({ ...valid }, 'email', { value: 'private@example.test' });
    const withSymbol = { ...valid, [Symbol('private')]: 'sensitive' };
    expect(() => projectFeatures(hidden)).toThrow(/^Invalid AI features$/);
    expect(() => projectFeatures(withSymbol)).toThrow(/^Invalid AI features$/);
  });

  it('allows no history with null median and preserves zero fields', () => {
    const input = { ...valid, historyCount30d: 0, medianAmount30d: null, accountAgeHours: 0 };
    expect(projectFeatures(input)).toEqual(input);
  });

  it.each([1, 2, 3, 4])(
    'allows sub-threshold historyCount30d=%i with null median (matching FeatureProvider R2 rule)',
    historyCount30d => {
      const input = { ...valid, historyCount30d, medianAmount30d: null };
      expect(projectFeatures(input)).toEqual(input);
    },
  );

  it('maps TransferEvent + Features from FeatureProvider into FeatureInput', () => {
    const event: TransferEvent = {
      eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
      eventType: 'TransferCompleted',
      occurredAt: '2026-10-19T06:00:00.000Z',
      correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
      transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
      type: 'TRANSFER',
      fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
      toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
      amount: '20000000',
      fromBalanceBefore: '22000000',
      fromAccountCreatedAt: '2026-10-19T03:00:00.000Z',
      toAccountCreatedAt: '2026-01-15T08:00:00.000Z',
      sameOwner: false,
      fromUserId: 'b2e5c8a1-6f40-4d93-8c17-a9d3f0e6b724',
      toUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
    };
    const features: Features = {
      txCount10m: 2,
      txCount1h: 3,
      historyCount30d: 6,
      medianAmount30dTimes2: '10000001',
      reverseTransferOccurredAt: '2026-10-19T05:45:00.000Z',
      newRecipients1h: 2,
      distinctRecipients24h: 3,
      sumOut24h: '25000000',
      smallTxCount24h: 1,
    };

    expect(toAiFeatureInput(event, features)).toEqual({
      amount: '20000000',
      fromBalanceBefore: '22000000',
      accountAgeHours: 3,
      sameOwner: false,
      txCount10m: 2,
      txCount1h: 3,
      historyCount30d: 6,
      medianAmount30d: '5000000.5',
      minutesSinceReverse: 15,
      newRecipients1h: 2,
      distinctRecipients24h: 3,
    });
    expect(
      toAiFeatureInput(event, { ...features, medianAmount30dTimes2: '18446744073709551614' })
        .medianAmount30d,
    ).toBe('9223372036854775807');
    expect(
      toAiFeatureInput(event, { ...features, medianAmount30dTimes2: '18446744073709551613' })
        .medianAmount30d,
    ).toBe('9223372036854775806.5');
    for (const medianAmount30dTimes2 of [
      '0',
      '1',
      '02',
      '2e0',
      '18446744073709551615',
      '9'.repeat(1000),
    ]) {
      expect(() => toAiFeatureInput(event, { ...features, medianAmount30dTimes2 })).toThrow(
        'Invalid AI features',
      );
    }

    for (const badEvent of [
      { ...event, occurredAt: ['2026-10-19T06:00:00.000Z'] },
      { ...event, fromAccountCreatedAt: 0 },
    ]) {
      expect(() => toAiFeatureInput(badEvent as unknown as TransferEvent, features)).toThrow(
        /^Invalid AI features$/,
      );
    }
    expect(() =>
      toAiFeatureInput(event, {
        ...features,
        reverseTransferOccurredAt: ['2026-10-19T05:45:00.000Z'],
      } as unknown as Features),
    ).toThrow(/^Invalid AI features$/);

    let occurredReads = 0;
    const changingEvent = {
      ...event,
      get occurredAt(): string {
        occurredReads += 1;
        return occurredReads === 1 ? '2026-10-19T06:00:00.000Z' : '2026-10-20T06:00:00.000Z';
      },
    };
    expect(toAiFeatureInput(changingEvent, features).accountAgeHours).toBe(3);
    expect(occurredReads).toBe(1);

    const preciseEvent = {
      ...event,
      occurredAt: '2026-10-19T06:00:00.000000001Z',
      fromAccountCreatedAt: '2026-10-19T06:00:00.000000000Z',
    };
    const precise = toAiFeatureInput(preciseEvent, {
      ...features,
      reverseTransferOccurredAt: '2026-10-19T06:00:00.000000000Z',
    });
    expect(precise.accountAgeHours).toBe(1 / 3_600_000_000_000);
    expect(precise.minutesSinceReverse).toBe(1 / 60_000_000_000);
    for (const reverseTransferOccurredAt of [
      '2026-10-19T06:00:00.000000001Z',
      '2026-10-19T06:00:00.000000002Z',
    ]) {
      expect(() =>
        toAiFeatureInput(preciseEvent, { ...features, reverseTransferOccurredAt }),
      ).toThrow(/^Invalid AI features$/);
    }
  });
});
