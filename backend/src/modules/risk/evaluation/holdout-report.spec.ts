import type { AiAssessment } from '../ai/ai-contract';
import type { CaptureLine } from './capture-ai';
import { evaluateRules } from './evaluate-rules';
import { measureHoldout, type HoldoutOptions } from './holdout-report';

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
const THRESHOLDS = { medium: 40, high: 70 };
const RULE_ONLY = { mode: 'rule_only', thresholds: THRESHOLDS, rules: RULES };
const WITH_AI = {
  mode: 'rules_with_external_ai',
  thresholds: THRESHOLDS,
  rules: RULES,
  ai: {
    provider: 'openai',
    model: 'm',
    rubric: 'rubric',
    threshold: 0.65,
    weight: 40,
    maxAdmissionDelayMs: 1000,
    requestTimeoutMs: 20000,
  },
};

const answer = (probability: number, responseModel = 'm-2026'): AiAssessment => ({
  status: 'SUCCEEDED',
  probability,
  provider: 'openai',
  requestedModel: 'm',
  responseModel,
  requestId: null,
  rubricSha256: 'rubric-hash',
  inputSha256: null,
  usage: { inputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0 },
});

interface Fixture {
  csv: string;
  capture: Map<string, CaptureLine>;
}

/**
 * 100 customers, each with one fraud row and one NORMAL row (`normalWeight` CSV rows per NORMAL row).
 *  - kind A (30): R3 fires (new account, 20 000 000) and the AI sees it. ATO_DRAIN, in scope.
 *  - kind B (30): quiet (500 000, old account): only the AI sees it. MULE_FANOUT, in scope.
 *  - kind C (20): quiet, and the AI is blind to it. SLOW_DRIP, out of scope (`aiSeesC` flips the AI).
 *  - kind D (20): quiet, the AI is blind to it. BUST_OUT, in scope: nobody catches it.
 * The AI says 0.1 for every NORMAL row.
 */
function dataset(normalWeight: number, aiSeesC = false): Fixture {
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
    const kind = c < 30 ? 'A' : c < 60 ? 'B' : c < 80 ? 'C' : 'D';
    const scenario = { A: 'ATO_DRAIN', B: 'MULE_FANOUT', C: 'SLOW_DRIP', D: 'BUST_OUT' }[kind];
    lines.push(
      row(
        `f${c}`,
        customer,
        c,
        kind === 'A' ? '20000000' : '500000',
        kind === 'A' ? NEW_ACCOUNT : OLD_ACCOUNT,
        1,
        scenario,
      ),
    );
    lines.push(row(`n${c}`, customer, c + 1, '500000', OLD_ACCOUNT, 0, 'NORMAL'));
    const sees = kind === 'A' || kind === 'B' || (kind === 'C' && aiSeesC);
    put(`f${c}`, 1, sees ? 0.95 : 0.1);
    put(`n${c}`, normalWeight, 0.1);
  }
  return { csv: lines.join('\n'), capture };
}

const options = (fixture: Fixture, extra: Partial<HoldoutOptions> = {}): HoldoutOptions => ({
  csvText: fixture.csv,
  ruleOnly: { config: RULE_ONLY, version: 4 },
  withAi: { config: WITH_AI, version: 5 },
  capture: fixture.capture,
  requireFullCapture: false,
  bootstrapSeed: 'test-holdout',
  iterations: 300,
  ...extra,
});

describe('holdout measurement at fixed parameters (BL-407)', () => {
  it('TC-407-01 B0, B1 and B2 are counted with the frozen thresholds, nothing is re-chosen', async () => {
    const report = await measureHoldout(options(dataset(1000)));
    expect(report.parameters).toEqual({
      ruleOnlyVersion: 4,
      withAiVersion: 5,
      thresholds: THRESHOLDS,
      ai: { model: 'm', threshold: 0.65, weight: 40 },
    });
    // B0 flags only kind A; B1 flags kinds A and B; B2 = rules + 40 flags kinds A and B (0 + 40 >= 40).
    expect(report.modes.b0.recall).toBeCloseTo(0.3, 6);
    expect(report.modes.b1.recall).toBeCloseTo(0.6, 6);
    expect(report.modes.b2.recall).toBeCloseTo(0.6, 6);
    expect(report.modes.b0.precision).toBe(1);
    expect(report.modes.b2.precision).toBe(1);
    expect(report.modes.b0.fp).toBe(0);
    expect(report.sample).toMatchObject({ transfers: 200, fraud: 100, customers: 100 });
  });

  it('TC-407-02 per scenario recall lists the out-of-scope scenario too', async () => {
    const { byScenario } = await measureHoldout(options(dataset(1000)));
    const by = Object.fromEntries(byScenario.map(r => [r.scenario, r]));
    expect(by.ATO_DRAIN).toMatchObject({ inScope: true, fraud: 30, b0: 1, b1: 1, b2: 1 });
    expect(by.MULE_FANOUT).toMatchObject({ inScope: true, fraud: 30, b0: 0, b1: 1, b2: 1 });
    expect(by.SLOW_DRIP).toMatchObject({ inScope: false, fraud: 20, b0: 0, b1: 0, b2: 0 });
    expect(by.BUST_OUT).toMatchObject({ inScope: true, fraud: 20, b0: 0, b1: 0, b2: 0 });
  });

  it('TC-407-03 ablation removes one rule at a time from B0 and B2', async () => {
    const { ablation } = await measureHoldout(options(dataset(1000)));
    const r3 = ablation.rules.find(entry => entry.rule === 'R3')!;
    // Without R3 the rules alone catch nothing; B2 still catches kind A through the AI weight (85 -> 40).
    expect(r3.b0.recall).toBe(0);
    expect(r3.b0.deltaRecall).toBeCloseTo(-0.3, 6);
    expect(r3.b2.recall).toBeCloseTo(0.6, 6);
    expect(r3.b2.deltaRecall).toBeCloseTo(0, 6);
    const r1 = ablation.rules.find(entry => entry.rule === 'R1')!;
    expect(r1.b0.deltaRecall).toBe(0);
    expect(ablation.rules.map(entry => entry.rule)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
    // B2 without its AI part is B0.
    expect(ablation.b2WithoutAi.recall).toBeCloseTo(0.3, 6);
  });

  it('TC-407-04 precision-recall curves and average precision', async () => {
    const { curves } = await measureHoldout(options(dataset(1000)));
    const at45 = curves.b0.find(point => point.threshold === 45)!;
    expect(at45).toMatchObject({ precision: 1 });
    expect(at45.recall).toBeCloseTo(0.3, 6);
    // The AI answer separates fraud (0.95, kinds A and B) from NORMAL (0.1) perfectly, but is blind
    // to kinds C and D, so 40% of the fraud is only retrieved together with every NORMAL row: the
    // average precision is the recall reached at precision 1, plus a negligible tail.
    expect(curves.averagePrecision.b1).toBeCloseTo(0.6, 2);
    expect(curves.b1.some(point => point.threshold === 0.65)).toBe(true);
    for (const mode of ['b0', 'b1', 'b2'] as const) {
      for (const point of curves[mode]) {
        expect(point.recall).toBeGreaterThanOrEqual(0);
        expect(point.recall).toBeLessThanOrEqual(1);
      }
    }
  });

  it('TC-407-05 the paired bootstrap resamples customers and is reproducible from its seed', async () => {
    const first = await measureHoldout(options(dataset(1000)));
    const again = await measureHoldout(options(dataset(1000)));
    expect(again).toEqual(first);
    const gain = first.bootstrap.recallGain.overall;
    expect(gain.point).toBeCloseTo(0.3, 6);
    expect(gain.low).toBeGreaterThan(0);
    expect(gain.low).toBeLessThanOrEqual(gain.point);
    expect(gain.high).toBeGreaterThanOrEqual(gain.point);
    expect(first.bootstrap.iterations).toBe(300);
    const other = await measureHoldout(options(dataset(1000), { bootstrapSeed: 'another' }));
    expect(other.modes).toEqual(first.modes);
    // A different seed draws different customers: at least one interval bound moves.
    const bounds = (r: typeof first): number[] => [
      r.bootstrap.recallGain.overall.low,
      r.bootstrap.recallGain.overall.high,
      r.bootstrap.alertsPer1000.b2.low,
      r.bootstrap.alertsPer1000.b2.high,
      r.bootstrap.alertsPer1000.difference.low,
      r.bootstrap.alertsPer1000.difference.high,
    ];
    expect(bounds(other)).not.toEqual(bounds(first));
  });

  it('TC-407-06 alert volume per 1 000 transfers has its own interval, B2 against B0', async () => {
    const { bootstrap, modes } = await measureHoldout(options(dataset(1000)));
    expect(modes.b2.alertsPer1000).toBeCloseTo(modes.b0.alertsPer1000 * 2, 3);
    expect(bootstrap.alertsPer1000.b2.point).toBeCloseTo(modes.b2.alertsPer1000, 3);
    expect(bootstrap.alertsPer1000.b2.low).toBeLessThanOrEqual(bootstrap.alertsPer1000.b2.high);
    expect(bootstrap.alertsPer1000.difference.point).toBeCloseTo(
      modes.b2.alertsPer1000 - modes.b0.alertsPer1000,
      3,
    );
  });

  it('TC-407-07 the gate items use the ADR-14 targets and never claim the latency item', async () => {
    const { gate } = await measureHoldout(options(dataset(1000)));
    const byName = (needle: string) => gate.items.find(item => item.name.includes(needle))!;
    expect(byName('Recall gain').status).toBe('pass'); // 30 points, interval above 5
    expect(byName('in-scope').status).toBe('pass'); // 60 of the 80 in-scope fraud rows
    expect(byName('per 1 000').status).toBe('pass');
    expect(byName('p95').status).toBe('not-measured');
    expect(gate.verdict).toBe('INCOMPLETE');
    const noisy = await measureHoldout(options(dataset(1)));
    expect(noisy.gate.items.find(item => item.name.includes('per 1 000'))!.status).toBe('fail');
    expect(noisy.gate.verdict).toBe('NO-GO');
  });

  it('TC-407-08 it agrees with evaluate-rules on the whole file (all rows weight 1)', async () => {
    const fixture = dataset(1);
    const ruleOnly = await evaluateRules({
      csvText: fixture.csv,
      config: RULE_ONLY,
      configVersion: 4,
    });
    const withAi = await evaluateRules({
      csvText: fixture.csv,
      config: WITH_AI,
      configVersion: 5,
      capture: new Map([...fixture.capture].map(([id, line]) => [id, line.assessment])),
    });
    const report = await measureHoldout(options(fixture, { requireFullCapture: true }));
    for (const key of ['tp', 'fp', 'fn', 'tn'] as const) {
      expect(report.modes.b0[key]).toBe(ruleOnly.metrics[key]);
      expect(report.modes.b2[key]).toBe(withAi.metrics[key]);
    }
    expect(report.modes.b2.alertsPer1000).toBeCloseTo(withAi.metrics.alertsPer1000, 4);
  });

  it('TC-407-09 a holdout capture must cover every transfer; a sparse tune capture need not', async () => {
    const fixture = dataset(1);
    fixture.capture.delete('n7');
    await expect(measureHoldout(options(fixture, { requireFullCapture: true }))).rejects.toThrow(
      /missing 1 transfer/i,
    );
    await expect(
      measureHoldout(options(fixture, { requireFullCapture: false })),
    ).resolves.toBeDefined();
  });

  it('TC-407-10 a capture row that is not in the CSV is refused', async () => {
    const fixture = dataset(1);
    fixture.capture.set('ghost', fixture.capture.get('n1')!);
    await expect(measureHoldout(options(fixture))).rejects.toThrow(/not in the CSV: ghost/);
  });

  it('TC-407-11 the two configurations must score the rules the same way', async () => {
    const fixture = dataset(1);
    const drifted = { ...WITH_AI, rules: { ...RULES, R1: { ...RULES.R1, maxTransfers: 2 } } };
    await expect(
      measureHoldout(options(fixture, { withAi: { config: drifted, version: 5 } })),
    ).rejects.toThrow(/rules and thresholds/i);
    await expect(
      measureHoldout(options(fixture, { ruleOnly: { config: WITH_AI, version: 4 } })),
    ).rejects.toThrow(/rule_only/);
    await expect(
      measureHoldout(options(fixture, { withAi: { config: RULE_ONLY, version: 5 } })),
    ).rejects.toThrow(/rules_with_external_ai/);
  });

  it('TC-407-12 a file without labels is refused (not a labelled holdout)', async () => {
    const fixture = dataset(1);
    const unlabeled = fixture.csv.replace(
      /,1,(ATO_DRAIN|MULE_FANOUT|SLOW_DRIP|BUST_OUT)/g,
      ',0,$1',
    );
    await expect(measureHoldout(options({ ...fixture, csv: unlabeled }))).rejects.toThrow(
      /no row has is_fraud=1/,
    );
  });

  it('TC-407-13 an out-of-scope scenario caught by the engine is flagged for a leakage check', async () => {
    const plain = await measureHoldout(options(dataset(1000)));
    expect(plain.leakageWarnings).toEqual([]);
    // The AI suddenly "sees" a scenario no rule and no feature covers: that is what leakage looks like.
    const leaky = await measureHoldout(options(dataset(1000, true)));
    expect(leaky.leakageWarnings.some(w => w.includes('SLOW_DRIP'))).toBe(true);
  });

  it('TC-407-14 provenance lists the response models, rubric hashes and statuses of the capture', async () => {
    const fixture = dataset(1000);
    fixture.capture.set('n3', {
      ...fixture.capture.get('n3')!,
      assessment: answer(0.1, 'm-2027'),
    });
    const { provenance, cost } = await measureHoldout(options(fixture));
    expect(provenance.responseModels).toEqual(['m-2026', 'm-2027']);
    expect(provenance.rubricSha256).toEqual(['rubric-hash']);
    expect(provenance.statusCounts).toEqual({ SUCCEEDED: 200 });
    expect(cost.calls).toBe(200);
    expect(cost.inputTokens).toBe(200_000);
  });

  it('TC-407-15 failed AI answers are reported and warned about, never counted as AI flags', async () => {
    const fixture = dataset(1000);
    for (let c = 0; c < 40; c++) {
      fixture.capture.set(`f${c}`, {
        ...fixture.capture.get(`f${c}`)!,
        assessment: {
          ...answer(0),
          status: 'UNAVAILABLE',
          probability: null,
          responseModel: null,
          rubricSha256: null,
          usage: null,
        },
      });
    }
    const report = await measureHoldout(options(fixture));
    expect(report.provenance.statusCounts.UNAVAILABLE).toBe(40);
    expect(report.leakageWarnings.some(w => /did not succeed/i.test(w))).toBe(true);
    expect(report.modes.b1.recall).toBeLessThan(0.6);
  });
});
