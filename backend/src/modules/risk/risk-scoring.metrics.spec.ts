import { register } from 'prom-client';
import { LATENCY_BOUNDS_MS } from '@common/metrics/latency-histogram';
import {
  AI_STATUSES,
  countDecision,
  countRuleError,
  DECISION_METRIC,
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
