import type { AiAssessment } from '../ai/ai-contract';
import { evaluateRules, parseCapture } from './evaluate-rules';

const HEADER =
  'tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario';
const NEW_ACCOUNT = '2026-10-01T09:00:00.000Z';
const OLD_ACCOUNT = '2024-01-01T00:00:00.000Z';
const row = (
  id: string,
  minute: number,
  amount: string,
  createdAt: string,
  fraud: 0 | 1,
  scenario: string,
): string =>
  [
    id,
    `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`,
    `from-${id}`,
    `to-${id}`,
    `cust-from-${id}`,
    `cust-to-${id}`,
    amount,
    '1000000000',
    createdAt,
    OLD_ACCOUNT,
    String(fraud),
    scenario,
  ].join(',');

// A: new account, 20 000 000 (> 10 000 000)  → R3 hits, fraud          → true positive
// B: old account, 500 000                    → no rule, fraud          → false negative
// C: new account, 20 000 000                 → R3 hits, not fraud      → false positive
// D: old account, 500 000                    → no rule, not fraud      → true negative
const CSV = [
  HEADER,
  row('A', 0, '20000000', NEW_ACCOUNT, 1, 'ATO_DRAIN'),
  row('B', 1, '500000', OLD_ACCOUNT, 1, 'SLOW_DRIP'),
  row('C', 2, '20000000', NEW_ACCOUNT, 0, 'HN_NEW_SALARY'),
  row('D', 3, '500000', OLD_ACCOUNT, 0, 'NORMAL'),
].join('\n');

const RULES = {
  R1: { enabled: true, weight: 30, maxTransfers: 5, windowMinutes: 10 },
  R2: { enabled: true, weight: 25, medianMultiplier: 5, historyDays: 30, minHistory: 5 },
  R3: {
    enabled: true,
    weight: 45,
    maxAccountAgeHoursExclusive: 24,
    minAmountExclusive: '10000000',
  },
  R4: { enabled: true, weight: 20, reverseWindowMinutes: 60 },
  R5: {
    enabled: true,
    weight: 40,
    minNewRecipients: 5,
    windowMinutes: 60,
    noveltyDays: 30,
    sameOwnerExempt: true,
  },
  R6: {
    enabled: true,
    weight: 30,
    minBalancePercent: 90,
    minBalance: '1000000',
    sameOwnerExempt: true,
  },
};
const RULE_ONLY = { mode: 'rule_only', thresholds: { medium: 40, high: 70 }, rules: RULES };
const WITH_AI = {
  ...RULE_ONLY,
  mode: 'rules_with_external_ai',
  ai: {
    provider: 'openai',
    model: 'test-model',
    rubric: 'rubric text',
    threshold: 0.5,
    weight: 40,
    maxAdmissionDelayMs: 1000,
    requestTimeoutMs: 1000,
  },
};

const assessment = (probability: number): AiAssessment => ({
  status: 'SUCCEEDED',
  probability,
  provider: 'openai',
  requestedModel: 'test-model',
  responseModel: 'test-model-2026',
  requestId: null,
  rubricSha256: 'rubric-hash',
  inputSha256: null,
  usage: null,
});
// The AI says "fraud" for A and B, "not fraud" for C and D.
const CAPTURE = new Map<string, AiAssessment>([
  ['A', assessment(0.9)],
  ['B', assessment(0.8)],
  ['C', assessment(0.1)],
  ['D', assessment(0.1)],
]);

describe('evaluateRules (DBS-132)', () => {
  it('TC-132-01 counts the confusion matrix and metrics exactly as computed by hand', async () => {
    const report = await evaluateRules({
      csvText: CSV,
      config: RULE_ONLY,
      configVersion: 7,
      seed: 'seed-x',
    });
    expect(report.metrics).toEqual({
      tp: 1,
      fp: 1,
      fn: 1,
      tn: 1,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      falsePositiveRate: 0.5,
      alertsPer1000: 500,
    });
    expect(report.byScenario).toEqual({
      ATO_DRAIN: { fraud: 1, caught: 1, recall: 1 },
      SLOW_DRIP: { fraud: 1, caught: 0, recall: 0 },
    });
    // ATO_DRAIN is in scope, SLOW_DRIP is not.
    expect(report.inScopeRecall).toEqual({ fraud: 1, caught: 1, recall: 1 });
    expect(report.hardNegatives).toEqual({ HN_NEW_SALARY: { rows: 1, flagged: 1 } });
    expect(report).toMatchObject({
      configVersion: 7,
      mode: 'rule_only',
      seed: 'seed-x',
      transactions: 4,
      frauds: 2,
      baseline: null,
      ai: null,
    });
  });

  it('TC-132-02 the same input gives the same report', async () => {
    const options = { csvText: CSV, config: RULE_ONLY, configVersion: 1 };
    expect(await evaluateRules(options)).toEqual(await evaluateRules(options));
  });

  it('TC-132-03 refuses a file without the label column or without any fraud label', async () => {
    const noLabelColumn = CSV.split('\n')
      .map(line =>
        line
          .split(',')
          .filter((_, i) => i !== 10)
          .join(','),
      )
      .join('\n');
    await expect(
      evaluateRules({ csvText: noLabelColumn, config: RULE_ONLY, configVersion: 1 }),
    ).rejects.toThrow(/missing required column 'is_fraud'/);
    const allZero = CSV.replace(/,1,(ATO_DRAIN|SLOW_DRIP)/g, ',0,$1');
    await expect(
      evaluateRules({ csvText: allZero, config: RULE_ONLY, configVersion: 1 }),
    ).rejects.toThrow(/no row has is_fraud=1/);
  });

  it('TC-132-04 B2 reads the capture and reports the paired B0 on the same rows', async () => {
    const report = await evaluateRules({
      csvText: CSV,
      config: WITH_AI,
      configVersion: 2,
      capture: CAPTURE,
    });
    // B0: A and C flagged by R3 (45 >= 40); B and D not.
    expect(report.baseline).toMatchObject({ tp: 1, fp: 1, fn: 1, tn: 1 });
    // B2: B reaches 0 + 40 = 40 through the AI weight; C and D are not raised by the AI.
    expect(report.metrics).toMatchObject({ tp: 2, fp: 1, fn: 0, tn: 1, recall: 1 });
    expect(report.ai).toEqual({
      model: 'test-model',
      threshold: 0.5,
      weight: 40,
      rubricSha256: ['rubric-hash'],
      responseModels: ['test-model-2026'],
      statusCounts: { SUCCEEDED: 4 },
      captured: 4,
    });
  });

  it('TC-132-05 refuses to run B2 when a transfer has no captured answer or there is no capture', async () => {
    const partial = new Map(CAPTURE);
    partial.delete('D');
    await expect(
      evaluateRules({ csvText: CSV, config: WITH_AI, configVersion: 2, capture: partial }),
    ).rejects.toThrow(/missing 1 transfer\(s\), first: D/);
    await expect(
      evaluateRules({ csvText: CSV, config: WITH_AI, configVersion: 2 }),
    ).rejects.toThrow(/needs --ai-capture/);
  });

  it('TC-132-06 restrictToCapture evaluates only the captured transfers', async () => {
    const subset = new Map([...CAPTURE].filter(([id]) => id === 'A' || id === 'B'));
    const report = await evaluateRules({
      csvText: CSV,
      config: WITH_AI,
      configVersion: 2,
      capture: subset,
      restrictToCapture: true,
    });
    expect(report.transactions).toBe(2);
    expect(report.metrics).toMatchObject({ tp: 2, fp: 0, fn: 0, tn: 0 });
    await expect(
      evaluateRules({
        csvText: CSV,
        config: WITH_AI,
        configVersion: 2,
        capture: new Map([['ghost', assessment(0.9)]]),
        restrictToCapture: true,
      }),
    ).rejects.toThrow(/not in the CSV: ghost/);
  });

  it('TC-132-07 refuses a capture for a rule_only config and an unusable ai block', async () => {
    await expect(
      evaluateRules({ csvText: CSV, config: RULE_ONLY, configVersion: 1, capture: CAPTURE }),
    ).rejects.toThrow(/need a rules_with_external_ai config/);
    const brokenAi = { ...WITH_AI, ai: { ...WITH_AI.ai, threshold: 7 } };
    await expect(
      evaluateRules({ csvText: CSV, config: brokenAi, configVersion: 2, capture: CAPTURE }),
    ).rejects.toThrow(/ai\.\* block .* invalid/);
  });

  it('TC-132-08 parseCapture reads JSON lines and names the bad line', () => {
    const line = (txId: string): string => JSON.stringify({ txId, assessment: assessment(0.5) });
    expect([...parseCapture(`${line('a')}\n\n${line('b')}\n`).keys()]).toEqual(['a', 'b']);
    expect(() => parseCapture(`${line('a')}\nnot json`)).toThrow(/line 2: not valid JSON/);
    expect(() => parseCapture(`${line('a')}\n${line('a')}`)).toThrow(/line 2: duplicate txId/);
    expect(() => parseCapture('{"txId":"a"}')).toThrow(/line 1: assessment.status/);
    expect(() => parseCapture('{"assessment":{"status":"SUCCEEDED"}}')).toThrow(/txId/);
  });
});
