import type { TransferCompleted } from '@common/events';
import type { FeatureProvider, Features } from './features/feature-provider';
import { OfflineFeatureProvider } from './features/offline-feature-provider';
import { OnlineFeatureProvider } from './features/online-feature-provider';
import type { RiskRule, RuleParams, TransferEvent } from './rules/rule';

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
const deposit: TransferCompleted = {
  ...event,
  type: 'DEPOSIT',
  fromUserId: null,
  sameOwner: false,
};
const features: Features = {
  txCount10m: 6,
  txCount1h: 8,
  historyCount30d: 12,
  medianAmount30dTimes2: '1000000',
  reverseTransferOccurredAt: null,
  newRecipients1h: 2,
  distinctRecipients24h: 4,
  sumOut24h: '2500000',
  smallTxCount24h: 1,
};
const params: RuleParams = { enabled: true, weight: 30, thresholds: { maxCount: 5 } };

describe('DBS-59 risk contracts', () => {
  it('TC-59-01/04 allows a pure fake rule to return a hit or null', () => {
    const fake: RiskRule = {
      id: 'R1',
      evaluate(_event, input, config) {
        return config.enabled && input.txCount10m > Number(config.thresholds.maxCount)
          ? { id: this.id, weight: config.weight, explanation: '6 lệnh chuyển trong 10 phút' }
          : null;
      },
    };
    expect(fake.evaluate(event, features, params)).toEqual({
      id: 'R1',
      weight: 30,
      explanation: '6 lệnh chuyển trong 10 phút',
    });
    expect(fake.evaluate(event, features, { ...params, enabled: false })).toBeNull();
  });

  it('TC-59-02 accepts a fake provider but placeholders fail explicitly', async () => {
    const fake: FeatureProvider = { extract: () => Promise.resolve(features) };
    await expect(fake.extract(event)).resolves.toEqual(features);
    await expect(new OnlineFeatureProvider().extract(event)).rejects.toThrow(
      'Online feature provider is not configured',
    );
    await expect(new OfflineFeatureProvider().extract(event)).rejects.toThrow(
      'Offline feature provider is not configured',
    );
  });

  it('TC-59-01 narrows rule input to transfers at compile time', () => {
    // @ts-expect-error A deposit is not a transfer event for scoring.
    const invalid: TransferEvent = deposit;
    expect(invalid.type).toBe('DEPOSIT');
  });
});
