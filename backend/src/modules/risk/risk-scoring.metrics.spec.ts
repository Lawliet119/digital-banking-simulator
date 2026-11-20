import { register } from 'prom-client';
import { LATENCY_BOUNDS_MS } from '@common/metrics/latency-histogram';
import {
  AI_STATUSES,
  classifyAiAdded,
  countDecision,
  countFlag,
  countRuleError,
  DECISION_METRIC,
  FLAG_METRIC,
  RULE_ERROR_METRIC,
} from './risk-scoring.metrics';

async function valueOf(metric: string, label: string, value: string): Promise<number> {
  const values = (await register.getSingleMetric(metric)?.get())?.values ?? [];
  return values.find(v => v.labels[label] === value)?.value ?? 0;
}
async function labelValues(metric: string): Promise<string[]> {
  const values = (await register.getSingleMetric(metric)?.get())?.values ?? [];
  return values.flatMap(v => Object.values(v.labels).map(String));
}

describe('risk scoring counters (BL-204, BL-207)', () => {
  it('TC-204-04 countDecision counts every ai_status of the schema under its own label', async () => {
    for (const status of AI_STATUSES) {
      const before = await valueOf(DECISION_METRIC, 'ai_status', status);
      countDecision(status);
      expect(await valueOf(DECISION_METRIC, 'ai_status', status)).toBe(before + 1);
    }
    expect([...AI_STATUSES].sort()).toEqual(
      [
        'BUDGET_EXHAUSTED',
        'CONFIG_INVALID',
        'DISABLED',
        'INVALID_RESPONSE',
        'REFUSED',
        'SUCCEEDED',
        'UNAVAILABLE',
      ].sort(),
    );
  });

  it('TC-204-05 a rule id or ai_status that is not in the fixed set becomes "unknown": no id, e-mail or amount reaches a label', async () => {
    countRuleError('R3');
    countRuleError('user@example.com' as never);
    countRuleError('3f2b8c1e-9a4d-4e21-8c7a-1b2c3d4e5f60' as never);
    countDecision('20000000' as never);
    const allowed = new Set(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'unknown', ...AI_STATUSES]);
    for (const label of [
      ...(await labelValues(RULE_ERROR_METRIC)),
      ...(await labelValues(DECISION_METRIC)),
    ]) {
      expect(allowed.has(label)).toBe(true);
    }
    expect(await valueOf(RULE_ERROR_METRIC, 'rule', 'unknown')).toBeGreaterThanOrEqual(2);
  });

  it('TC-204-05 each counter has exactly one label, the one MetricsService maps to a dimension', () => {
    const rule = register.getSingleMetric(RULE_ERROR_METRIC) as unknown as {
      labelNames: string[];
    };
    const decision = register.getSingleMetric(DECISION_METRIC) as unknown as {
      labelNames: string[];
    };
    expect(rule.labelNames).toEqual(['rule']);
    expect(decision.labelNames).toEqual(['ai_status']);
  });

  it('TC-204-06 the SLO thresholds of the distributions are histogram bounds (5 s for transfer to flag)', () => {
    expect(LATENCY_BOUNDS_MS).toContain(5000);
  });
});

const fullLabels = async (metric: string): Promise<Array<Record<string, string>>> =>
  ((await register.getSingleMetric(metric)?.get())?.values ?? []).map(v =>
    Object.fromEntries(Object.entries(v.labels).map(([k, x]) => [k, String(x)])),
  );
const flagCount = async (labels: Record<string, string>): Promise<number> =>
  ((await register.getSingleMetric(FLAG_METRIC)?.get())?.values ?? []).find(v =>
    Object.entries(labels).every(([k, x]) => String(v.labels[k]) === x),
  )?.value ?? 0;

describe('risk_flag_total (DBS-187)', () => {
  const thresholds = { medium: 40, high: 70 };

  it('TC-187-01 countFlag counts each valid combination under its own three labels', async () => {
    for (const level of ['MEDIUM', 'HIGH'] as const)
      for (const mode of ['rule_only', 'rules_with_external_ai'] as const)
        for (const aiAdded of ['none', 'created', 'raised'] as const) {
          const labels = { risk_level: level, mode, ai_added: aiAdded };
          const before = await flagCount(labels);
          countFlag(level, mode, aiAdded);
          expect(await flagCount(labels)).toBe(before + 1);
        }
    const metric = register.getSingleMetric(FLAG_METRIC) as unknown as { labelNames: string[] };
    expect(metric.labelNames).toEqual(['risk_level', 'mode', 'ai_added']);
  });

  it('TC-187-02 classifyAiAdded: created, raised or none from the rule-only level and the final level', () => {
    // [ruleScore, final score, expected]; thresholds 40/70
    const table: Array<[number, number, string]> = [
      [30, 45, 'created'], // LOW -> MEDIUM
      [30, 75, 'created'], // LOW -> HIGH
      [50, 80, 'raised'], // MEDIUM -> HIGH
      [40, 80, 'raised'], // rule score equal to medium
      [50, 55, 'none'], // MEDIUM -> MEDIUM
      [75, 100, 'none'], // HIGH -> HIGH
      [30, 30, 'none'], // no AI weight
    ];
    for (const [ruleScore, score, expected] of table)
      expect(classifyAiAdded(ruleScore, score, thresholds)).toBe(expected);
  });

  it('TC-187-04 a level, mode or ai_added outside the fixed sets becomes "unknown": no id or amount reaches a label', async () => {
    countFlag(
      'user@example.com' as never,
      '20000000' as never,
      '3f2b8c1e-9a4d-4e21-8c7a-1b2c3d4e5f60' as never,
    );
    const allowed: Record<string, Set<string>> = {
      risk_level: new Set(['MEDIUM', 'HIGH', 'unknown']),
      mode: new Set(['rule_only', 'rules_with_external_ai', 'unknown']),
      ai_added: new Set(['none', 'created', 'raised', 'unknown']),
    };
    for (const labels of await fullLabels(FLAG_METRIC))
      for (const [name, value] of Object.entries(labels))
        expect(allowed[name].has(value)).toBe(true);
    expect(await flagCount({ risk_level: 'unknown', mode: 'unknown', ai_added: 'unknown' })).toBe(
      1,
    );
  });
});
