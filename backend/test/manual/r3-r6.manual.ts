import assert from 'node:assert/strict';
import type { Features, TransferEvent } from '../../src/modules/risk/features/feature-provider';
import { R3NewAccountLargeTransferRule } from '../../src/modules/risk/rules/r3-new-account-large-transfer.rule';
import { R4RoundTripRule } from '../../src/modules/risk/rules/r4-round-trip.rule';
import { R5FanOutRule } from '../../src/modules/risk/rules/r5-fan-out.rule';
import { R6DrainRule } from '../../src/modules/risk/rules/r6-drain.rule';
import type { RuleParams } from '../../src/modules/risk/rules/rule';

const event: TransferEvent = {
  eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
  eventType: 'TransferCompleted',
  occurredAt: '2026-10-19T12:00:00.000000001Z',
  correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
  transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
  type: 'TRANSFER',
  fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
  toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  amount: '20000000',
  fromBalanceBefore: '20800000',
  fromAccountCreatedAt: '2026-10-19T09:00:00.000000001Z',
  toAccountCreatedAt: '2026-01-15T08:00:00.000Z',
  sameOwner: false,
  fromUserId: 'b2e5c8a1-6f40-4d93-8c17-a9d3f0e6b724',
  toUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
};
const features: Features = {
  txCount10m: 1,
  txCount1h: 5,
  historyCount30d: 5,
  medianAmount30dTimes2: '2000000',
  reverseTransferOccurredAt: '2026-10-19T11:00:00.000000001Z',
  newRecipients1h: 5,
  distinctRecipients24h: 5,
  sumOut24h: '20000000',
  smallTxCount24h: 0,
};
const configs: Record<'R3' | 'R4' | 'R5' | 'R6', RuleParams> = {
  R3: {
    enabled: true,
    weight: 35,
    thresholds: { maxAccountAgeHoursExclusive: 24, minAmountExclusive: '10000000' },
  },
  R4: { enabled: true, weight: 20, thresholds: { reverseWindowMinutes: 60 } },
  R5: {
    enabled: true,
    weight: 40,
    thresholds: { minNewRecipients: 5, windowMinutes: 60, noveltyDays: 30 },
  },
  R6: { enabled: true, weight: 30, thresholds: { minBalancePercent: 90, minBalance: '1000000' } },
};
const r3 = new R3NewAccountLargeTransferRule();
const r4 = new R4RoundTripRule();
const r5 = new R5FanOutRule();
const r6 = new R6DrainRule();

const young = r3.evaluate(event, features, configs.R3);
const exactAge = r3.evaluate(
  { ...event, fromAccountCreatedAt: '2026-10-18T12:00:00.000000001Z' },
  features,
  configs.R3,
);
const exactAmount = r3.evaluate({ ...event, amount: '10000000' }, features, configs.R3);
assert.equal(young?.id, 'R3');
assert.equal(exactAge, null);
assert.equal(exactAmount, null);
console.log('M-95-01:', JSON.stringify({ young, exactAge, exactAmount }));

const atHour = r4.evaluate(event, features, configs.R4);
const older = r4.evaluate(
  event,
  { ...features, reverseTransferOccurredAt: '2026-10-19T11:00:00.000000000Z' },
  configs.R4,
);
assert.equal(atHour?.id, 'R4');
assert.equal(older, null);
console.log('M-105-01:', JSON.stringify({ atHour, older }));

const four = r5.evaluate(event, { ...features, newRecipients1h: 4 }, configs.R5);
const five = r5.evaluate(event, features, configs.R5);
const same = r5.evaluate({ ...event, sameOwner: true }, features, configs.R5);
assert.equal(four, null);
assert.equal(five?.id, 'R5');
assert.equal(same, null);
console.log('M-106-01:', JSON.stringify({ four, five, same }));

const at90 = r6.evaluate(
  { ...event, amount: '900000', fromBalanceBefore: '1000000' },
  features,
  configs.R6,
);
const below90 = r6.evaluate(
  { ...event, amount: '899999', fromBalanceBefore: '1000000' },
  features,
  configs.R6,
);
const sameOwner = r6.evaluate({ ...event, sameOwner: true }, features, configs.R6);
assert.equal(at90?.id, 'R6');
assert.equal(below90, null);
assert.equal(sameOwner, null);
console.log('M-107-01:', JSON.stringify({ at90, below90, sameOwner }));

const deposit = { ...event, type: 'DEPOSIT', fromUserId: null } as unknown as TransferEvent;
for (const [rule, config] of [
  [r3, configs.R3],
  [r4, configs.R4],
  [r5, configs.R5],
  [r6, configs.R6],
] as const) {
  assert.equal(rule.evaluate(deposit, features, config), null);
}
assert.throws(() =>
  r3.evaluate({ ...event, fromAccountCreatedAt: 'invalid' }, features, configs.R3),
);
console.log('M-95/105/106/107-02: DEPOSIT skipped; invalid timestamp rejected');
