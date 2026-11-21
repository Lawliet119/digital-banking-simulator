import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DISTRIBUTION_METRICS, emittedCounterDimensionSets } from './metrics.service';

/**
 * BL-412: contract between what `MetricsService` writes and what the CloudWatch alarms read.
 *
 * An alarm gets data only when its `dimensions` equal ONE dimension set of the EMF line exactly. If
 * `MetricsService` changes the dimensions of a counter (say `risk_flag_total` loses `[Role]`), the
 * alarm has no data and, because the alarms use `notBreaching`, stays quietly green. `alarms.tftest.hcl`
 * pins the Terraform side only; this test pins the two sides together, red when they drift.
 */
const ALARMS_TF = resolve(__dirname, '../../../../infra/terraform/envs/dev/session/alarms.tf');

/**
 * Metrics an alarm reads that are NOT counters of `MetricsService`: CloudWatch built-ins, the HTTP lines, the
 * gauges and the distributions. They have their own dimension rules; a metric outside both this list and the
 * counters is reported, so a renamed or removed counter cannot make its alarm quietly lose data.
 */
const NOT_COUNTERS: ReadonlySet<string> = new Set([
  'ApproximateAgeOfOldestMessage',
  'CPUUtilization',
  'http_5xx_total',
  'http_requests_total',
  'http_request_duration_ms',
  'outbox_oldest_unpublished_age_seconds',
  'outbox_quarantined_events',
  ...DISTRIBUTION_METRICS,
]);

export interface AlarmMetric {
  metric: string;
  /** Dimension names, sorted; empty when the block has no `dimensions`. */
  dimensions: string[];
}

/**
 * Every `metric_name` in the Terraform text with the dimension names of the same block. A block ends at
 * the next `metric_name`, `resource "`, `dynamic "` or `metric_query {` so a block without dimensions never borrows the
 * dimensions of the next one.
 */
export function readAlarmMetrics(tf: string): AlarmMetric[] {
  const text = tf
    .split('\n')
    .map(line => line.replace(/^\s*#.*$/, ''))
    .join('\n');
  const found: AlarmMetric[] = [];
  const blocks =
    /metric_name\s*=\s*"([^"]+)"([\s\S]*?)(?=metric_name\s*=|\bresource\s+"|\bdynamic\s+"|\bmetric_query\s*\{|$)/g;
  for (const [, metric, rest] of text.matchAll(blocks)) {
    const body = /\bdimensions\s*=\s*\{([^}]*)\}/.exec(rest)?.[1] ?? '';
    const dimensions = [...body.matchAll(/(\w+)\s*=/g)].map(m => m[1]).sort();
    found.push({ metric, dimensions });
  }
  return found;
}

/** What is wrong, one line per alarm metric whose dimensions the application does not write. */
export function findDrift(alarms: AlarmMetric[], emitted: Map<string, string[][]>): string[] {
  const problems: string[] = [];
  for (const { metric, dimensions } of alarms) {
    const sets = emitted.get(metric);
    if (!sets) {
      if (!NOT_COUNTERS.has(metric)) {
        problems.push(
          `${metric}: an alarm reads it but it is neither a counter the application writes nor a known non-counter`,
        );
      }
      continue;
    }
    const wanted = dimensions.join(',');
    if (!sets.some(set => [...set].sort().join(',') === wanted)) {
      problems.push(
        `${metric}: alarm reads [${wanted}] but the application writes ${sets
          .map(set => `[${[...set].sort().join(',')}]`)
          .join(' and ')}`,
      );
    }
  }
  return problems;
}

describe('alarm contract: dimensions of counters (BL-412)', () => {
  const tf = readFileSync(ALARMS_TF, 'utf8');
  const emitted = emittedCounterDimensionSets();

  it('TC-412-01 every counter an alarm reads is written with exactly those dimensions', () => {
    expect(findDrift(readAlarmMetrics(tf), emitted)).toEqual([]);
  });

  it('TC-412-02 the contract is not vacuous: the risk counters of the flag, config and fallback alarms are all read', () => {
    const read = readAlarmMetrics(tf);
    const dims = (metric: string) =>
      read
        .filter(a => a.metric === metric)
        .map(a => a.dimensions.join(','))
        .sort();
    // dbs-dev-risk-flag-rate: numerator and denominator, the [Role] total of both counters.
    expect(dims('risk_flag_total')).toContain('Role');
    expect(dims('risk_decision_total')).toEqual(expect.arrayContaining(['Role', 'AiStatus,Role']));
    // dbs-dev-risk-config-invalid and dbs-dev-risk-ai-fallback-rate read [Role, AiStatus].
    expect(dims('risk_decision_total').filter(d => d === 'AiStatus,Role').length).toBeGreaterThan(
      1,
    );
    expect(dims('risk_config_redis_fallback_total')).toContain('Role');
  });

  it('TC-412-03 drift is reported: a counter that loses its [Role] total or renames a dimension', () => {
    const alarms = readAlarmMetrics(`
      resource "aws_cloudwatch_metric_alarm" "x" {
        metric_name = "risk_flag_total"
        dimensions  = { Role = local.alarm_role_worker }
      }
      resource "aws_cloudwatch_metric_alarm" "y" {
        metric_name = "risk_decision_total"
        dimensions  = { Role = local.alarm_role_worker, AiStatus = "SUCCEEDED" }
      }
    `);
    expect(findDrift(alarms, emittedCounterDimensionSets())).toEqual([]);
    // The application stops writing the [Role] total of risk_flag_total.
    const noTotal = new Map(emitted);
    noTotal.set('risk_flag_total', [['Role', 'RiskLevel', 'Mode', 'AiAdded']]);
    expect(findDrift(alarms, noTotal)).toEqual([
      'risk_flag_total: alarm reads [Role] but the application writes [AiAdded,Mode,RiskLevel,Role]',
    ]);
    // The application renames the AiStatus dimension.
    const renamed = new Map(emitted);
    renamed.set('risk_decision_total', [['Role', 'Status'], ['Role']]);
    expect(findDrift(alarms, renamed)).toHaveLength(1);
  });

  it('TC-412-05 a metric that no counter writes and no non-counter list names is reported (renamed or removed counter)', () => {
    const alarms = readAlarmMetrics(`
      metric_name = "risk_flag_totl"
      dimensions  = { Role = local.alarm_role_worker }
    `);
    expect(findDrift(alarms, emitted)).toEqual([
      'risk_flag_totl: an alarm reads it but it is neither a counter the application writes nor a known non-counter',
    ]);
    // The real alarms read no such metric, and the three risk counters of the flag, config and fallback alarms exist.
    for (const name of [
      'risk_flag_total',
      'risk_decision_total',
      'risk_config_redis_fallback_total',
    ]) {
      expect(emitted.has(name)).toBe(true);
    }
  });

  it('TC-412-04 a block without dimensions does not borrow the next block, and comments are ignored', () => {
    const alarms = readAlarmMetrics(`
      # metric_name = "risk_flag_total"  dimensions = { Role = "x" }
      metric_name = "risk_flag_total"
      namespace   = "DBS/Backend"
      resource "aws_cloudwatch_metric_alarm" "z" {
        metric_name = "CPUUtilization"
        dimensions  = { Role = "worker" }
      }
    `);
    expect(alarms).toEqual([
      { metric: 'risk_flag_total', dimensions: [] },
      { metric: 'CPUUtilization', dimensions: ['Role'] },
    ]);
    // An empty dimension set `[]` is never written for a counter, so an alarm without dimensions is drift.
    expect(findDrift(alarms, emitted)).toHaveLength(1);
  });
});
