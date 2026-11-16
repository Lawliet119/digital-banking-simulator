import type { AiAssessment } from '../ai/ai-contract';
import type { CaptureLine } from './capture-ai';
import { compareModes } from './compare-modes';

const HEADER =
  'tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario';
const NEW_ACCOUNT = '2026-10-01T09:00:00.000Z';
const OLD_ACCOUNT = '2024-01-01T00:00:00.000Z';
const row = (
  id: string,
  customer: string,
  minute: number,
  amount: string,
  createdAt: string,
  fraud: 0 | 1,
  scenario: string,
): string =>
  [
    id,
    `2026-10-01T10:${String(minute % 60).padStart(2, '0')}:00.000Z`,
    `from-${id}`,
    `to-${id}`,
    customer,
    `to-${customer}`,
    amount,
    '1000000000',
    createdAt,
    OLD_ACCOUNT,
    String(fraud),
    scenario,
  ].join(',');

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
const CONFIG = { mode: 'rule_only', thresholds: { medium: 40, high: 70 }, rules: RULES };

const answer = (probability: number): AiAssessment => ({
  status: 'SUCCEEDED',
  probability,
  provider: 'openai',
  requestedModel: 'm',
  responseModel: 'm-2026',
  requestId: null,
  rubricSha256: 'rubric-hash',
  inputSha256: null,
  usage: { inputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0 },
});

// 100 customers, each with one fraud row and one NORMAL row.
//  - even customers: the fraud row is caught by the rules (R3: new account, 20 000 000), in scope
//  - odd customers: the fraud row is quiet (500 000, old account): only the AI sees it, out of scope
// The AI says 0.95 for every fraud row and 0.1 for every NORMAL row. Each NORMAL row stands for 1 000
// CSV rows, so the alert volume per 1 000 transfers is tiny.
function dataset(): { csv: string; capture: Map<string, CaptureLine> } {
  const lines = [HEADER];
  const capture = new Map<string, CaptureLine>();
  const put = (id: string, weight: number, probability: number): void => {
    capture.set(id, {
      txId: id,
      sampleWeight: weight,
      attempts: 1,
      latencyMs: 100,
      assessment: answer(probability),
    });
  };
  for (let c = 0; c < 100; c++) {
    const customer = `cust-${c}`;
    const quiet = c % 2 === 1;
    lines.push(
      row(
        `f${c}`,
        customer,
        c,
        quiet ? '500000' : '20000000',
        quiet ? OLD_ACCOUNT : NEW_ACCOUNT,
        1,
        quiet ? 'SLOW_DRIP' : 'ATO_DRAIN',
      ),
    );
    lines.push(row(`n${c}`, customer, c + 1, '500000', OLD_ACCOUNT, 0, 'NORMAL'));
    put(`f${c}`, 1, 0.95);
    put(`n${c}`, 1000, 0.1);
  }
  return { csv: lines.join('\n'), capture };
}

describe('compareModes (DBS-212)', () => {
  it('TC-212-08 B2 beats B0, the parameters come from train and the gate waits for the load test', async () => {
    const { csv, capture } = dataset();
    const report = await compareModes({
      csvText: csv,
      config: CONFIG,
      configVersion: 1,
      capture,
      seed: 'seed',
      bootstrapIterations: 500,
    });

    // The split is by customer: every customer lands on one side only.
    expect(report.sample.transfers).toBe(200);
    expect(report.sample.trainCustomers + report.sample.validationCustomers).toBe(100);
    expect(report.sample.trainRows + report.sample.validationRows).toBe(200);

    // Train picks the smallest weight that lifts a quiet fraud row to the MEDIUM threshold, and the
    // highest threshold that still catches the AI's 0.95.
    expect(report.chosen).toMatchObject({
      threshold: 0.95,
      weight: 40,
      selectedOn: 'train',
      feasible: true,
    });

    const { b0, b1, b2 } = report.validation;
    expect(b0.metrics.recall).toBeLessThan(1);
    expect(b1.metrics.recall).toBe(1);
    expect(b2.metrics.recall).toBe(1);
    expect(b2.metrics.alertsPer1000).toBeLessThan(20);

    // The extra B2 flags are all right (quiet fraud rows) and none is wrong.
    expect(report.aiExtraFlags.rightSample).toBeGreaterThan(0);
    expect(report.aiExtraFlags.wrongSample).toBe(0);

    const slow = report.byScenario.find(row => row.scenario === 'SLOW_DRIP')!;
    expect(slow).toMatchObject({ inScope: false, b0: 0, b2: 1 });
    const ato = report.byScenario.find(row => row.scenario === 'ATO_DRAIN')!;
    expect(ato).toMatchObject({ inScope: true, b0: 1, b2: 1 });

    expect(report.recallGain.overall.point).toBeGreaterThanOrEqual(0.05);
    expect(report.recallGain.overall.low).toBeGreaterThan(0);

    // Cost: 200 transfers x 1 000 tokens at $0.10/1M = $0.02, i.e. $0.10 per 1 000 transfers.
    expect(report.cost).toMatchObject({
      transfers: 200,
      calls: 200,
      inputTokens: 200_000,
      usd: 0.02,
    });
    expect(report.cost.usdPer1000Transfers).toBe(0.1);
    expect(report.provenance).toMatchObject({
      models: ['m-2026'],
      rubricSha256: ['rubric-hash'],
      statusCounts: { SUCCEEDED: 200 },
    });

    // Three measured items pass; the p95 item is not measurable offline, so the verdict is not GO.
    expect(report.gate.items.map(item => item.status)).toEqual([
      'pass',
      'pass',
      'pass',
      'not-measured',
    ]);
    expect(report.gate.verdict).toBe('INCOMPLETE');
  });

  it('TC-212-09 the same input and seed give the same report', async () => {
    const { csv, capture } = dataset();
    const options = {
      csvText: csv,
      config: CONFIG,
      configVersion: 1,
      capture,
      seed: 'seed',
      bootstrapIterations: 200,
    };
    expect(await compareModes(options)).toEqual(await compareModes(options));
  });

  it('TC-212-10 an AI that adds nothing is a NO-GO', async () => {
    const { csv, capture } = dataset();
    const silent = new Map<string, CaptureLine>();
    for (const [id, line] of capture) {
      silent.set(id, { ...line, assessment: answer(0.1) });
    }
    const report = await compareModes({
      csvText: csv,
      config: CONFIG,
      configVersion: 1,
      capture: silent,
      seed: 'seed',
      bootstrapIterations: 200,
    });
    expect(report.recallGain.overall.point).toBe(0);
    expect(report.gate.items[0].status).toBe('fail');
    expect(report.gate.verdict).toBe('NO-GO');
  });

  it('TC-212-11 refuses a capture for a transfer that is not in the CSV and an empty capture', async () => {
    const { csv, capture } = dataset();
    const ghost = new Map(capture).set('ghost', capture.get('f0')!);
    await expect(
      compareModes({ csvText: csv, config: CONFIG, configVersion: 1, capture: ghost, seed: 's' }),
    ).rejects.toThrow(/not in the CSV: ghost/);
    await expect(
      compareModes({
        csvText: csv,
        config: CONFIG,
        configVersion: 1,
        capture: new Map(),
        seed: 's',
      }),
    ).rejects.toThrow(/no transfer to compare/);
  });
});
