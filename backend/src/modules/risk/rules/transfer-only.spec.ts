import type { Features, TransferEvent } from '../features/feature-provider';
import { R1VelocityRule } from './r1-velocity.rule';
import { R2UnusualAmountRule } from './r2-unusual-amount.rule';
import { R3NewAccountLargeTransferRule } from './r3-new-account-large-transfer.rule';
import { R4RoundTripRule } from './r4-round-trip.rule';
import { R5FanOutRule } from './r5-fan-out.rule';
import { R6DrainRule } from './r6-drain.rule';
import type { RiskRule, RuleParams } from './rule';

const event: TransferEvent = {
  eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
  eventType: 'TransferCompleted',
  occurredAt: '2026-10-19T12:00:00.000Z',
  correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
  transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
  type: 'TRANSFER',
  fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
  toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  amount: '95000000',
  fromBalanceBefore: '100000000',
  fromAccountCreatedAt: '2026-10-19T09:00:00.000Z',
  toAccountCreatedAt: '2026-01-15T08:00:00.000Z',
  sameOwner: false,
  fromUserId: 'b2e5c8a1-6f40-4d93-8c17-a9d3f0e6b724',
  toUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
};
const features: Features = {
  txCount10m: 6,
  txCount1h: 6,
  historyCount30d: 5,
  medianAmount30dTimes2: '2000000',
  reverseTransferOccurredAt: '2026-10-19T11:45:00.000Z',
  newRecipients1h: 5,
  distinctRecipients24h: 5,
  sumOut24h: '95000000',
  smallTxCount24h: 0,
};
const configs: Array<[RiskRule, RuleParams]> = [
  [
    new R1VelocityRule(),
    { enabled: true, weight: 30, thresholds: { maxTransfers: 5, windowMinutes: 10 } },
  ],
  [
    new R2UnusualAmountRule(),
    {
      enabled: true,
      weight: 25,
      thresholds: { medianMultiplier: 5, historyDays: 30, minHistory: 5 },
    },
  ],
  [
    new R3NewAccountLargeTransferRule(),
    {
      enabled: true,
      weight: 35,
      thresholds: { maxAccountAgeHoursExclusive: 24, minAmountExclusive: '10000000' },
    },
  ],
  [new R4RoundTripRule(), { enabled: true, weight: 20, thresholds: { reverseWindowMinutes: 60 } }],
  [
    new R5FanOutRule(),
    {
      enabled: true,
      weight: 40,
      thresholds: { minNewRecipients: 5, windowMinutes: 60, noveltyDays: 30 },
    },
  ],
  [
    new R6DrainRule(),
    { enabled: true, weight: 30, thresholds: { minBalancePercent: 90, minBalance: '1000000' } },
  ],
];

describe('Fraud rules reject deposits', () => {
  it.each(configs)(
    '$id ignores a DEPOSIT even when its features would otherwise trigger',
    (rule, params) => {
      expect(rule.evaluate(event, features, params)?.id).toBe(rule.id);
      const deposit = { ...event, type: 'DEPOSIT', fromUserId: null } as unknown as TransferEvent;
      expect(rule.evaluate(deposit, features, params)).toBeNull();
    },
  );
});
