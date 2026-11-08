import assert from 'node:assert/strict';
import type { Features, TransferEvent } from '../../src/modules/risk/features/feature-provider';
import { R2UnusualAmountRule } from '../../src/modules/risk/rules/r2-unusual-amount.rule';
import type { RuleParams } from '../../src/modules/risk/rules/rule';

const baseEvent: TransferEvent = {
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
const baseFeatures: Features = {
  txCount10m: 1,
  txCount1h: 1,
  historyCount30d: 12,
  medianAmount30dTimes2: '8000000',
  reverseTransferOccurredAt: null,
  newRecipients1h: 1,
  distinctRecipients24h: 1,
  sumOut24h: '500000',
  smallTxCount24h: 1,
};
const v1: RuleParams = {
  enabled: true,
  weight: 25,
  thresholds: { medianMultiplier: 5, historyDays: 30, minHistory: 5 },
};
const rule = new R2UnusualAmountRule();
const event = (amount: string): TransferEvent => ({ ...baseEvent, amount });
const features = (overrides: Partial<Features>): Features => ({ ...baseFeatures, ...overrides });

// M-94-01: median 4 000 000 (doubled 8 000 000)
const atFive = rule.evaluate(event('20000000'), baseFeatures, v1);
const above = rule.evaluate(event('50000000'), baseFeatures, v1);
assert.equal(atFive, null);
assert.deepEqual(above, {
  id: 'R2',
  weight: 25,
  explanation: 'Số tiền 50000000 gấp 12,5× trung vị 30 ngày (4000000)',
});
console.log(JSON.stringify({ case: 'M-94-01', exactlyFiveTimes: atFive, aboveFiveTimes: above }));

// M-94-02: four history rows
const skipped = rule.evaluate(
  event('50000000'),
  features({ historyCount30d: 4, medianAmount30dTimes2: null }),
  v1,
);
assert.equal(skipped, null);
console.log(JSON.stringify({ case: 'M-94-02', historyCount30d: 4, result: skipped }));

// M-94-03: amounts above 2^53, median 1 801 439 850 948 199
const big = features({ medianAmount30dTimes2: '3602879701896398' });
const bigEqual = rule.evaluate(event('9007199254740995'), big, v1);
const bigAbove = rule.evaluate(event('9007199254740996'), big, v1);
assert.equal(bigEqual, null);
assert(bigAbove);
console.log(JSON.stringify({ case: 'M-94-03', exactlyFiveTimes: bigEqual, onePastIt: bigAbove }));

// M-94-04: tiny excess and a half median
const million = features({ medianAmount30dTimes2: '2000000' });
const tiny = rule.evaluate(event('5000001'), million, v1);
const half = rule.evaluate(event('5000003'), features({ medianAmount30dTimes2: '2000001' }), v1);
assert.equal(tiny?.explanation, 'Số tiền 5000001 gấp hơn 5× trung vị 30 ngày (1000000)');
assert(half?.explanation.endsWith('(1000000,5)'));
console.log(JSON.stringify({ case: 'M-94-04', tinyExcess: tiny, halfMedian: half }));

// M-94-05: rule disabled
const disabled = rule.evaluate(event('50000000000'), million, { ...v1, enabled: false });
assert.equal(disabled, null);
console.log(JSON.stringify({ case: 'M-94-05', result: disabled }));

// M-94-06: a history window the provider does not supply
assert.throws(
  () =>
    rule.evaluate(event('50000000'), baseFeatures, {
      ...v1,
      thresholds: { ...v1.thresholds, historyDays: 15 },
    }),
  Error,
);
console.log(JSON.stringify({ case: 'M-94-06', result: 'CONFIG_ERROR' }));

// M-94-07: a DEPOSIT is never scored
const deposit = { ...baseEvent, type: 'DEPOSIT', amount: '50000000' } as unknown as TransferEvent;
const depositResult = rule.evaluate(deposit, baseFeatures, v1);
assert.equal(depositResult, null);
console.log(JSON.stringify({ case: 'M-94-07', type: 'DEPOSIT', result: depositResult }));
