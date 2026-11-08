import assert from 'node:assert/strict';
import type { AiAssessment } from '../../src/modules/risk/ai/ai-contract';
import { toAiFeatureInput } from '../../src/modules/risk/ai/feature-projection';
import type { Features, TransferEvent } from '../../src/modules/risk/features/feature-provider';
import { ScoringService, type ScoringConfig } from '../../src/modules/risk/scoring.service';

const event: TransferEvent = {
  eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
  eventType: 'TransferCompleted',
  occurredAt: '2026-10-19T12:00:00.000Z',
  correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
  transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
  type: 'TRANSFER',
  fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
  toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  amount: '20000000',
  fromBalanceBefore: '20800000',
  fromAccountCreatedAt: '2026-10-19T09:00:00.000Z',
  toAccountCreatedAt: '2026-01-15T08:00:00.000Z',
  sameOwner: false,
  fromUserId: 'b2e5c8a1-6f40-4d93-8c17-a9d3f0e6b724',
  toUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
};
const facts: Features = {
  txCount10m: 1,
  txCount1h: 1,
  historyCount30d: 0,
  medianAmount30dTimes2: null,
  reverseTransferOccurredAt: null,
  newRecipients1h: 1,
  distinctRecipients24h: 1,
  sumOut24h: '20000000',
  smallTxCount24h: 0,
};
const baseline: ScoringConfig = {
  thresholds: { medium: 40, high: 70 },
  rules: {
    R1: { enabled: true, weight: 30, thresholds: { maxTransfers: 5, windowMinutes: 10 } },
    R2: {
      enabled: true,
      weight: 25,
      thresholds: { medianMultiplier: 5, historyDays: 30, minHistory: 5 },
    },
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
  },
};
const config: ScoringConfig = {
  ...baseline,
  mode: 'rules_with_external_ai',
  ai: { threshold: 0.9, weight: 40 },
};
const ai: AiAssessment = {
  status: 'SUCCEEDED',
  probability: 0.9,
  provider: 'openai',
  requestedModel: 'synthetic',
  responseModel: null,
  requestId: null,
  rubricSha256: null,
  inputSha256: null,
  usage: null,
};
const scorer = new ScoringService();
const base = scorer.score(event, facts, baseline);
assert.equal(base?.score, 65);
assert.equal(base.level, 'MEDIUM');
assert.deepEqual(
  base.hits.map(hit => hit.id),
  ['R3', 'R6'],
);
console.log('M-108-01:', JSON.stringify(base));

const quiet = { ...event, amount: '100000', fromBalanceBefore: '1000000' };
const aiOnly = scorer.score(quiet, facts, config, ai);
assert.equal(aiOnly?.score, 40);
assert.equal(aiOnly.aiAppliedWeight, 40);
assert.deepEqual(aiOnly.hits, []);
console.log('M-108-02:', JSON.stringify(aiOnly));

const failed = scorer.score(event, facts, config, {
  ...ai,
  status: 'UNAVAILABLE',
  probability: null,
});
assert.equal(failed?.score, 65);
assert.equal(failed.aiAppliedWeight, 0);
assert.equal(failed.aiStatus, 'UNAVAILABLE');
console.log('M-108-03:', JSON.stringify(failed));

const deposit = { ...event, type: 'DEPOSIT', fromUserId: null } as unknown as TransferEvent;
assert.equal(scorer.score(deposit, facts, baseline), null);
assert.throws(() =>
  scorer.score(event, facts, { ...baseline, thresholds: { medium: 70, high: 40 } }),
);
console.log('M-108-04: deposit skipped and invalid baseline configuration rejected');

const projected = toAiFeatureInput(event, {
  ...facts,
  historyCount30d: 6,
  medianAmount30dTimes2: '18446744073709551614',
});
assert.equal(projected.medianAmount30d, '9223372036854775807');
console.log('M-108-05: max valid median projected exactly:', projected.medianAmount30d);
