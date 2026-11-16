import { createHash } from 'node:crypto';
import type { AiAssessment } from '../ai/ai-contract';
import { parseRuleSet } from '../config/rule-set';
import { parseTransactionCsv } from '../features/export-features';
import { OfflineFeatureProvider } from '../features/offline-feature-provider';
import { ScoringService, type ScoringConfig } from '../scoring.service';
import type { CaptureLine } from './capture-ai';
import { IN_SCOPE_SCENARIOS } from './evaluate-rules';

/**
 * ADR-14 gate, offline part (DBS-212): compares B0 (rules), B1 (the AI answer alone) and B2 (rules +
 * AI) on the same transfers and the same capture.
 *
 * - The AI threshold and weight are chosen on the "train" customers only and measured on the
 *   "validation" customers (the split is by customer, so no customer is in both).
 * - Every capture row carries the number of CSV transfers it stands for (`sampleWeight`), so alert
 *   volume per 1 000 transfers is rebuilt from a sample instead of calling the API for every row.
 * - The recall gain of B2 over B0 comes with a 95% paired bootstrap interval resampling customers.
 *
 * The gate also needs p95 transfer-to-flag latency at 120 RPS; that is a load test of the running
 * system and is NOT measured here: the report says so and the verdict cannot be GO without it.
 */

const OFFLINE_PER_TX_LIMIT = 500_000_000n;
export const ALERT_BUDGET_PER_1000 = 20;
export const RECALL_GAIN_TARGET = 0.05;
export const IN_SCOPE_RECALL_TARGET = 0.7;
export const THRESHOLD_GRID: readonly number[] = [
  0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
];
export const WEIGHT_GRID: readonly number[] = [10, 20, 30, 40, 50, 60];
const TRAIN_SHARE = 0.7;

const round = (value: number, digits = 6): number => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Row {
  readonly id: string;
  readonly customer: string;
  readonly fraud: boolean;
  readonly scenario: string;
  readonly weight: number;
  readonly ruleScore: number;
  readonly assessment: AiAssessment;
}

interface AiParams {
  readonly threshold: number;
  readonly weight: number;
}

export interface WeightedMetrics {
  /** Weighted counts: they estimate the whole file, not the sample. */
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly alertsPer1000: number;
}

export interface ModeResult {
  readonly metrics: WeightedMetrics;
  /** Unweighted counts on the sample rows, for traceability. */
  readonly sampleFlagged: number;
  readonly sampleFraudCaught: number;
}

export interface ScenarioRow {
  readonly scenario: string;
  readonly inScope: boolean;
  readonly fraud: number;
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
}

export interface GridPoint {
  readonly threshold: number;
  readonly weight: number;
  readonly trainRecall: number;
  readonly trainAlertsPer1000: number;
  readonly feasible: boolean;
}

export type GateStatus = 'pass' | 'fail' | 'not-measured';

export interface GateItem {
  readonly name: string;
  readonly status: GateStatus;
  readonly detail: string;
}

export interface ComparisonReport {
  readonly sample: {
    readonly transfers: number;
    readonly fraud: number;
    readonly trainCustomers: number;
    readonly validationCustomers: number;
    readonly trainRows: number;
    readonly validationRows: number;
  };
  readonly chosen: AiParams & { readonly selectedOn: 'train'; readonly feasible: boolean };
  readonly grid: readonly GridPoint[];
  readonly validation: {
    readonly b0: ModeResult;
    readonly b1: ModeResult;
    readonly b2: ModeResult;
  };
  readonly byScenario: readonly ScenarioRow[];
  readonly aiExtraFlags: {
    /** Flagged by B2 but not by B0. */
    readonly rightSample: number;
    readonly wrongSample: number;
    readonly rightWeighted: number;
    readonly wrongWeighted: number;
  };
  readonly recallGain: {
    readonly overall: Interval;
    readonly inScope: Interval;
    readonly iterations: number;
  };
  readonly provenance: {
    readonly models: readonly string[];
    readonly rubricSha256: readonly string[];
    readonly statusCounts: Readonly<Record<string, number>>;
  };
  readonly cost: {
    readonly transfers: number;
    readonly calls: number;
    readonly inputTokens: number;
    readonly usd: number;
    readonly usdPer1000Transfers: number;
    readonly assumption: string;
    readonly callLatencyMs: { readonly p50: number; readonly p95: number };
  };
  readonly gate: {
    readonly items: readonly GateItem[];
    readonly verdict: 'GO' | 'NO-GO' | 'INCOMPLETE';
  };
}

export interface Interval {
  readonly point: number;
  readonly low: number;
  readonly high: number;
}

export interface CompareOptions {
  readonly csvText: string;
  /** `risk_rule_sets.config` JSON; the rules and thresholds of B0 (its `mode` is ignored). */
  readonly config: unknown;
  readonly configVersion: number;
  readonly capture: ReadonlyMap<string, CaptureLine>;
  readonly seed: string;
  readonly bootstrapIterations?: number;
  readonly usdPerMillionInputTokens?: number;
}

/** Deterministic PRNG (mulberry32) so the interval is reproducible from the seed. */
function prng(seedText: string): () => number {
  let a = parseInt(digest(seedText).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function metricsOf(rows: readonly Row[], flagged: (row: Row) => boolean): ModeResult {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let total = 0;
  let sampleFlagged = 0;
  let sampleFraudCaught = 0;
  for (const row of rows) {
    const flag = flagged(row);
    total += row.weight;
    if (flag) sampleFlagged += 1;
    if (row.fraud) {
      if (flag) {
        tp += row.weight;
        sampleFraudCaught += 1;
      } else fn += row.weight;
    } else if (flag) fp += row.weight;
    else tn += row.weight;
  }
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return {
    metrics: {
      tp: round(tp, 3),
      fp: round(fp, 3),
      fn: round(fn, 3),
      tn: round(tn, 3),
      precision: precision === null ? null : round(precision),
      recall: recall === null ? null : round(recall),
      f1: f1 === null ? null : round(f1),
      alertsPer1000: total === 0 ? 0 : round(((tp + fp) / total) * 1000, 4),
    },
    sampleFlagged,
    sampleFraudCaught,
  };
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index];
}

export async function compareModes(options: CompareOptions): Promise<ComparisonReport> {
  const iterations = options.bootstrapIterations ?? 2000;
  const price = options.usdPerMillionInputTokens ?? 0.1;
  const { facts, events, labels, scenarios } = parseTransactionCsv(options.csvText);
  const ruleSet = parseRuleSet(options.configVersion, options.config);
  const scoring = new ScoringService();
  const provider = new OfflineFeatureProvider(facts, OFFLINE_PER_TX_LIMIT);
  const known = new Set(events.map(event => event.transferId));
  for (const id of options.capture.keys()) {
    if (!known.has(id)) throw new Error(`Capture has a txId that is not in the CSV: ${id}`);
  }

  const rows: Row[] = [];
  for (const event of events) {
    const line = options.capture.get(event.transferId);
    if (!line) continue;
    const features = await provider.extract(event);
    const baseline = scoring.score(event, features, { ...ruleSet, mode: 'rule_only' });
    if (baseline === null) throw new Error(`Not a TRANSFER: ${event.transferId}`);
    rows.push({
      id: event.transferId,
      customer: event.fromUserId,
      fraud: labels.get(event.transferId) === '1',
      scenario: scenarios.get(event.transferId) ?? 'UNKNOWN',
      weight: line.sampleWeight,
      ruleScore: baseline.ruleScore,
      assessment: line.assessment,
    });
  }
  if (rows.length === 0) throw new Error('The capture has no transfer to compare');

  const isTrain = (customer: string): boolean =>
    parseInt(digest(`${options.seed}:split:${customer}`).slice(0, 8), 16) / 0x100000000 <
    TRAIN_SHARE;
  const train = rows.filter(row => isTrain(row.customer));
  const validation = rows.filter(row => !isTrain(row.customer));
  for (const [name, part] of [
    ['train', train],
    ['validation', validation],
  ] as const) {
    if (!part.some(row => row.fraud)) throw new Error(`The ${name} customers have no fraud row`);
  }

  const { medium } = ruleSet.thresholds;
  const config = (ai: AiParams): ScoringConfig => ({
    mode: 'rules_with_external_ai',
    thresholds: ruleSet.thresholds,
    rules: ruleSet.rules,
    ai,
  });
  const b0 = (row: Row): boolean => row.ruleScore >= medium;
  const b1 =
    (ai: AiParams) =>
    (row: Row): boolean =>
      row.assessment.status === 'SUCCEEDED' &&
      row.assessment.probability !== null &&
      row.assessment.probability >= ai.threshold;
  const b2 = (ai: AiParams) => {
    const cfg = config(ai);
    return (row: Row): boolean =>
      scoring.applyAssessment(
        { mode: 'rules_with_external_ai', hits: [], ruleScore: row.ruleScore },
        cfg,
        row.assessment,
      ).level !== 'LOW';
  };

  // Choose the AI threshold and weight on the train customers: the most recall that stays inside the
  // alert budget. Ties go to fewer alerts, then to the smaller weight, then to the higher threshold.
  const grid: GridPoint[] = [];
  for (const threshold of THRESHOLD_GRID) {
    for (const weight of WEIGHT_GRID) {
      const result = metricsOf(train, b2({ threshold, weight }));
      grid.push({
        threshold,
        weight,
        trainRecall: result.metrics.recall ?? 0,
        trainAlertsPer1000: result.metrics.alertsPer1000,
        feasible: result.metrics.alertsPer1000 <= ALERT_BUDGET_PER_1000,
      });
    }
  }
  const feasible = grid.filter(point => point.feasible);
  const pool = feasible.length > 0 ? feasible : grid;
  const best = [...pool].sort(
    (a, b) =>
      (feasible.length > 0 ? b.trainRecall - a.trainRecall : 0) ||
      a.trainAlertsPer1000 - b.trainAlertsPer1000 ||
      a.weight - b.weight ||
      b.threshold - a.threshold,
  )[0];
  const chosen: AiParams = { threshold: best.threshold, weight: best.weight };

  const flagB0 = b0;
  const flagB1 = b1(chosen);
  const flagB2 = b2(chosen);
  const result = {
    b0: metricsOf(validation, flagB0),
    b1: metricsOf(validation, flagB1),
    b2: metricsOf(validation, flagB2),
  };

  const scenarioNames = [
    ...new Set(validation.filter(row => row.fraud).map(row => row.scenario)),
  ].sort();
  const byScenario: ScenarioRow[] = scenarioNames.map(scenario => {
    const fraud = validation.filter(row => row.fraud && row.scenario === scenario);
    const rate = (flag: (row: Row) => boolean): number =>
      round(fraud.filter(flag).length / fraud.length);
    return {
      scenario,
      inScope: IN_SCOPE_SCENARIOS.includes(scenario),
      fraud: fraud.length,
      b0: rate(flagB0),
      b1: rate(flagB1),
      b2: rate(flagB2),
    };
  });

  let rightSample = 0;
  let wrongSample = 0;
  let rightWeighted = 0;
  let wrongWeighted = 0;
  for (const row of validation) {
    if (flagB2(row) && !flagB0(row)) {
      if (row.fraud) {
        rightSample += 1;
        rightWeighted += row.weight;
      } else {
        wrongSample += 1;
        wrongWeighted += row.weight;
      }
    }
  }

  // Paired bootstrap by customer over the validation fraud rows.
  const byCustomer = new Map<
    string,
    { n: number; b0: number; b2: number; sn: number; sb0: number; sb2: number }
  >();
  for (const row of validation.filter(r => r.fraud)) {
    const entry = byCustomer.get(row.customer) ?? { n: 0, b0: 0, b2: 0, sn: 0, sb0: 0, sb2: 0 };
    const scope = IN_SCOPE_SCENARIOS.includes(row.scenario);
    entry.n += 1;
    entry.b0 += flagB0(row) ? 1 : 0;
    entry.b2 += flagB2(row) ? 1 : 0;
    if (scope) {
      entry.sn += 1;
      entry.sb0 += flagB0(row) ? 1 : 0;
      entry.sb2 += flagB2(row) ? 1 : 0;
    }
    byCustomer.set(row.customer, entry);
  }
  const customers = [...byCustomer.values()];
  const gain = (pick: (c: (typeof customers)[number]) => [number, number, number]): Interval => {
    const total = customers.reduce(
      (acc, c) => {
        const [n, x0, x2] = pick(c);
        return [acc[0] + n, acc[1] + x0, acc[2] + x2];
      },
      [0, 0, 0],
    );
    const point = total[0] === 0 ? 0 : (total[2] - total[1]) / total[0];
    const random = prng(`${options.seed}:bootstrap`);
    const draws: number[] = [];
    for (let i = 0; i < iterations; i++) {
      let n = 0;
      let x0 = 0;
      let x2 = 0;
      for (let k = 0; k < customers.length; k++) {
        const [cn, c0, c2] = pick(customers[Math.floor(random() * customers.length)]);
        n += cn;
        x0 += c0;
        x2 += c2;
      }
      if (n > 0) draws.push((x2 - x0) / n);
    }
    draws.sort((a, b) => a - b);
    return {
      point: round(point),
      low: round(percentile(draws, 0.025)),
      high: round(percentile(draws, 0.975)),
    };
  };
  const recallGain = {
    overall: gain(c => [c.n, c.b0, c.b2]),
    inScope: gain(c => [c.sn, c.sb0, c.sb2]),
    iterations,
  };

  // Provenance and cost come from the whole capture, not only from validation.
  const lines = [...options.capture.values()];
  const statusCounts: Record<string, number> = {};
  const models = new Set<string>();
  const rubrics = new Set<string>();
  let inputTokens = 0;
  let calls = 0;
  const latencies: number[] = [];
  for (const line of lines) {
    statusCounts[line.assessment.status] = (statusCounts[line.assessment.status] ?? 0) + 1;
    if (line.assessment.responseModel) models.add(line.assessment.responseModel);
    if (line.assessment.rubricSha256) rubrics.add(line.assessment.rubricSha256);
    inputTokens += line.assessment.usage?.inputTokens ?? 0;
    calls += line.attempts;
    latencies.push(line.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  const usd = (inputTokens * price) / 1_000_000;
  const cost = {
    transfers: lines.length,
    calls,
    inputTokens,
    usd: round(usd, 4),
    usdPer1000Transfers: lines.length === 0 ? 0 : round((usd / lines.length) * 1000, 4),
    assumption: `input tokens x $${price}/1M, output not billed (provider guide as recorded in FRAUD-API-01); an estimate, not an invoice`,
    callLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
  };

  const v = result.b2.metrics;
  const items: GateItem[] = [
    {
      name: 'Recall gain of B2 over B0 >= 5 points and the 95% paired bootstrap interval excludes 0',
      status:
        recallGain.overall.point >= RECALL_GAIN_TARGET && recallGain.overall.low > 0
          ? 'pass'
          : 'fail',
      detail: `${(recallGain.overall.point * 100).toFixed(2)} points, 95% interval [${(recallGain.overall.low * 100).toFixed(2)}, ${(recallGain.overall.high * 100).toFixed(2)}] (validation customers)`,
    },
    {
      name: 'Pooled recall >= 70% on the 5 in-scope scenarios (B2)',
      status: (byScenarioRecall(byScenario, 'b2') ?? 0) >= IN_SCOPE_RECALL_TARGET ? 'pass' : 'fail',
      detail: `${((byScenarioRecall(byScenario, 'b2') ?? 0) * 100).toFixed(2)}% (B0 ${((byScenarioRecall(byScenario, 'b0') ?? 0) * 100).toFixed(2)}%)`,
    },
    {
      name: `<= ${ALERT_BUDGET_PER_1000} flags per 1 000 TRANSFER (B2)`,
      status: v.alertsPer1000 <= ALERT_BUDGET_PER_1000 ? 'pass' : 'fail',
      detail: `${v.alertsPer1000} per 1 000 (weighted estimate, B0 ${result.b0.metrics.alertsPer1000})`,
    },
    {
      name: 'p95 transfer-to-flag < 5 s at 120 RPS (B0 and B2)',
      status: 'not-measured',
      detail: 'needs a load test of the running system; this offline comparison cannot measure it',
    },
  ];
  const verdict = items.some(item => item.status === 'fail')
    ? 'NO-GO'
    : items.some(item => item.status === 'not-measured')
      ? 'INCOMPLETE'
      : 'GO';

  return {
    sample: {
      transfers: rows.length,
      fraud: rows.filter(row => row.fraud).length,
      trainCustomers: new Set(train.map(row => row.customer)).size,
      validationCustomers: new Set(validation.map(row => row.customer)).size,
      trainRows: train.length,
      validationRows: validation.length,
    },
    chosen: { ...chosen, selectedOn: 'train', feasible: feasible.length > 0 },
    grid,
    validation: result,
    byScenario,
    aiExtraFlags: {
      rightSample,
      wrongSample,
      rightWeighted: round(rightWeighted, 3),
      wrongWeighted: round(wrongWeighted, 3),
    },
    recallGain,
    provenance: {
      models: [...models].sort(),
      rubricSha256: [...rubrics].sort(),
      statusCounts: Object.fromEntries(
        Object.entries(statusCounts).sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    },
    cost,
    gate: { items, verdict },
  };
}

/** Pooled recall of one mode over the in-scope scenarios (validation fraud rows). */
function byScenarioRecall(rows: readonly ScenarioRow[], mode: 'b0' | 'b1' | 'b2'): number | null {
  let fraud = 0;
  let caught = 0;
  for (const row of rows) {
    if (!row.inScope) continue;
    fraud += row.fraud;
    caught += Math.round(row[mode] * row.fraud);
  }
  return fraud === 0 ? null : caught / fraud;
}
