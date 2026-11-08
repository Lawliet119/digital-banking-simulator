import assert from 'node:assert/strict';
import type { Features, TransferEvent } from '../../src/modules/risk/features/feature-provider';
import { R1VelocityRule } from '../../src/modules/risk/rules/r1-velocity.rule';
import type { RuleParams } from '../../src/modules/risk/rules/rule';

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
const rule = new R1VelocityRule();

const atThreshold = rule.evaluate(event, { ...features, txCount10m: 5 }, params);
const aboveThreshold = rule.evaluate(event, features, params);
assert.equal(atThreshold, null);
assert(aboveThreshold);
assert.equal(aboveThreshold.id, 'R1');
assert.equal(aboveThreshold.weight, 30);
assert(aboveThreshold.explanation.includes('6'));
assert(aboveThreshold.explanation.includes('10'));
assert(aboveThreshold.explanation.includes('5'));
console.log(JSON.stringify({ case: 'M-93-01', atThreshold, aboveThreshold }));

const disabled = rule.evaluate(event, features, { ...params, enabled: false });
assert.equal(disabled, null);
console.log(JSON.stringify({ case: 'M-93-02', result: disabled }));

assert.throws(
  () =>
    rule.evaluate(event, features, {
      ...params,
      thresholds: { ...params.thresholds, windowMinutes: 15 },
    }),
  Error,
);
console.log(JSON.stringify({ case: 'M-93-03', result: 'CONFIG_ERROR' }));

const deposit = { ...event, type: 'DEPOSIT' } as unknown as TransferEvent;
const depositResult = rule.evaluate(deposit, { ...features, txCount10m: 100 }, params);
assert.equal(depositResult, null);
console.log(
  JSON.stringify({ case: 'M-93-04', type: 'DEPOSIT', txCount10m: 100, result: depositResult }),
);
