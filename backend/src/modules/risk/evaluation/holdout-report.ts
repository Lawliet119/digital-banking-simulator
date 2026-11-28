import { createHash } from 'node:crypto';
import { parseRuleSet, type RuleSet } from '../config/rule-set';
import { parseTransactionCsv } from '../features/export-features';
import { OfflineFeatureProvider } from '../features/offline-feature-provider';
import type { RuleId } from '../rules/rule';
import { ScoringService } from '../scoring.service';
import type { CaptureLine } from './capture-ai';
import {
  ALERT_BUDGET_PER_1000,
  IN_SCOPE_RECALL_TARGET,
  RECALL_GAIN_TARGET,
  type GateItem,
  type Interval,
} from './compare-modes';
import { IN_SCOPE_SCENARIOS } from './evaluate-rules';

/**
 * Holdout measurement at FIXED parameters (BL-407, DBS-169).
 *
 * `compare-modes` picks the AI threshold and weight from the data it is given. On a holdout that
 * would be tuning on the holdout, so this module takes every parameter from the two frozen
 * configurations and chooses nothing: no grid, no train/validation split. It reports, on the whole
 * file, B0 (rules, frozen `rule_only`), B1 (the AI answer alone, at the frozen threshold) and B2
 * (rules + AI, frozen `rules_with_external_ai`), the recall of each scenario (also those no rule
 * targets), an ablation of every rule, precision-recall curves with their average precision, and
 * 95% paired bootstrap intervals by customer.
 *
 * It only reads: the AI answers come from one capture shared by B1 and B2 (ADR-14), the API is never
 * called here. Whoever runs it on a holdout runs it once (docs/components/risk/09-freeze-rule-config.md §5).
 */

const OFFLINE_PER_TX_LIMIT = 500_000_000n;
const RULE_IDS: readonly RuleId[] = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'];
const B1_GRID: readonly number[] = Array.from({ length: 19 }, (_, i) => (i + 1) / 20);
/** An out-of-scope scenario caught more often than this by the engine is not credible (no signal). */
const OUT_OF_SCOPE_SUSPECT_RECALL = 0.2;
const OUT_OF_SCOPE_MIN_FRAUD = 5;
/** More failed AI answers than this share of the capture make B1 and B2 incomparable with the tune. */
const MAX_FAILED_AI_SHARE = 0.01;

const round = (value: number, digits = 6): number => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Deterministic PRNG (mulberry32), so the intervals are reproducible from the seed. */
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

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index];
}

export interface HoldoutOptions {
  readonly csvText: string;
  /** Frozen `rule_only` configuration (`risk_rule_sets.config` JSON) and its evaluation label. */
  readonly ruleOnly: { readonly config: unknown; readonly version: number };
  /** Frozen `rules_with_external_ai` configuration and its evaluation label. */
  readonly withAi: { readonly config: unknown; readonly version: number };
  readonly capture: ReadonlyMap<string, CaptureLine>;
  /**
   * A holdout capture calls the API for every transfer. A sparse (weighted) capture such as the tune
   * one only measures the rows it holds; that is allowed for a dry run, never for the holdout.
   */
  readonly requireFullCapture: boolean;
  readonly bootstrapSeed: string;
  readonly iterations?: number;
  readonly usdPerMillionInputTokens?: number;
}

export interface ModeMetrics {
  /** Weighted counts: they estimate the whole file when the capture is sparse, equal rows when not. */
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly alertsPer1000: number;
  /** Recall over the five scenarios the rules target. */
  readonly inScopeRecall: number | null;
}

export interface AblationPoint {
  readonly recall: number | null;
  readonly inScopeRecall: number | null;
  readonly alertsPer1000: number;
  readonly deltaRecall: number;
  readonly deltaAlertsPer1000: number;
}

export interface CurvePoint {
  readonly threshold: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly alertsPer1000: number;
}

export interface ScenarioRecall {
  readonly scenario: string;
  readonly inScope: boolean;
  readonly fraud: number;
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
}

export interface HoldoutReport {
  readonly parameters: {
    readonly ruleOnlyVersion: number;
    readonly withAiVersion: number;
    readonly thresholds: { readonly medium: number; readonly high: number };
    readonly ai: { readonly model: string; readonly threshold: number; readonly weight: number };
  };
  readonly sample: {
    readonly transfers: number;
    readonly fraud: number;
    readonly customers: number;
    readonly fullCapture: boolean;
  };
  readonly modes: {
    readonly b0: ModeMetrics;
    readonly b1: ModeMetrics;
    readonly b2: ModeMetrics;
  };
  readonly byScenario: readonly ScenarioRecall[];
  readonly ablation: {
    readonly rules: readonly {
      readonly rule: RuleId;
      readonly b0: AblationPoint;
      readonly b2: AblationPoint;
    }[];
    /** B2 with the AI weight removed, which is B0: kept as the AI line of the ablation table. */
    readonly b2WithoutAi: AblationPoint;
  };
  readonly curves: {
    readonly b0: readonly CurvePoint[];
    readonly b1: readonly CurvePoint[];
    readonly b2: readonly CurvePoint[];
    readonly averagePrecision: {
      readonly b0: number | null;
      readonly b1: number | null;
      readonly b2: number | null;
    };
  };
  readonly bootstrap: {
    readonly iterations: number;
    readonly seed: string;
    readonly recallGain: { readonly overall: Interval; readonly inScope: Interval };
    readonly alertsPer1000: {
      readonly b0: Interval;
      readonly b2: Interval;
      readonly difference: Interval;
    };
  };
  readonly provenance: {
    readonly providers: readonly string[];
    readonly requestedModels: readonly string[];
    /** The alias is not an immutable snapshot: the model that really answered is recorded. */
    readonly responseModels: readonly string[];
    readonly rubricSha256: readonly string[];
    readonly statusCounts: Readonly<Record<string, number>>;
  };
  readonly cost: {
    readonly calls: number;
    readonly inputTokens: number;
    readonly usd: number;
    readonly assumption: string;
    readonly callLatencyMs: { readonly p50: number; readonly p95: number };
  };
  readonly gate: {
    readonly items: readonly GateItem[];
    readonly verdict: 'NO-GO' | 'INCOMPLETE';
  };
  /** Numbers too good, or an answer set too broken, to be used before somebody looked at them. */
  readonly leakageWarnings: readonly string[];
}

interface Row {
  readonly customer: string;
  readonly fraud: boolean;
  readonly scenario: string;
  readonly weight: number;
  readonly ruleScore: number;
  /** Weight of each rule that fired. */
  readonly hits: Readonly<Partial<Record<RuleId, number>>>;
  readonly aiApplied: number;
  /** The AI probability when the answer succeeded, `null` otherwise (never flagged by B1). */
  readonly probability: number | null;
  readonly b2Level: 'LOW' | 'MEDIUM' | 'HIGH';
}

type Flag = (row: Row) => boolean;

const sameJson = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function metricsOf(rows: readonly Row[], flagged: Flag): ModeMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let total = 0;
  let scopeFraud = 0;
  let scopeCaught = 0;
  for (const row of rows) {
    const flag = flagged(row);
    total += row.weight;
    if (row.fraud) {
      if (flag) tp += row.weight;
      else fn += row.weight;
      if (IN_SCOPE_SCENARIOS.includes(row.scenario)) {
        scopeFraud += row.weight;
        if (flag) scopeCaught += row.weight;
      }
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
    tp: round(tp, 3),
    fp: round(fp, 3),
    fn: round(fn, 3),
    tn: round(tn, 3),
    precision: precision === null ? null : round(precision),
    recall: recall === null ? null : round(recall),
    f1: f1 === null ? null : round(f1),
    alertsPer1000: total === 0 ? 0 : round(((tp + fp) / total) * 1000, 4),
    inScopeRecall: scopeFraud === 0 ? null : round(scopeCaught / scopeFraud),
  };
}

/** Points of the precision-recall curve for `score >= threshold`, one per threshold given. */
function curve(
  rows: readonly Row[],
  score: (row: Row) => number,
  thresholds: readonly number[],
): CurvePoint[] {
  return thresholds.map(threshold => {
    const m = metricsOf(rows, row => score(row) >= threshold);
    return {
      threshold,
      precision: m.precision,
      recall: m.recall,
      alertsPer1000: m.alertsPer1000,
    };
  });
}

/** Step-wise average precision over every distinct score (ties are one step). */
function averagePrecision(rows: readonly Row[], score: (row: Row) => number): number | null {
  const fraud = rows.reduce((sum, row) => sum + (row.fraud ? row.weight : 0), 0);
  if (fraud === 0) return null;
  const sorted = [...rows].sort((a, b) => score(b) - score(a));
  let tp = 0;
  let fp = 0;
  let lastRecall = 0;
  let area = 0;
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    if (row.fraud) tp += row.weight;
    else fp += row.weight;
    const last = i === sorted.length - 1 || score(sorted[i + 1]) !== score(row);
    if (!last) continue;
    if (!Number.isFinite(score(row))) break; // rows with no usable score are never retrieved
    const recall = tp / fraud;
    area += (recall - lastRecall) * (tp / (tp + fp));
    lastRecall = recall;
  }
  return round(area);
}

const distinct = (values: readonly number[]): number[] =>
  [...new Set(values)].sort((a, b) => a - b);

export async function measureHoldout(options: HoldoutOptions): Promise<HoldoutReport> {
  const iterations = options.iterations ?? 2000;
  const price = options.usdPerMillionInputTokens ?? 0.1;
  const { facts, events, labels, scenarios } = parseTransactionCsv(options.csvText);
  if (![...labels.values()].includes('1')) {
    throw new Error('Refusing to run: no row has is_fraud=1 (labels missing, not a labelled file)');
  }

  const ruleOnly: RuleSet = parseRuleSet(options.ruleOnly.version, options.ruleOnly.config);
  const withAi: RuleSet = parseRuleSet(options.withAi.version, options.withAi.config);
  if (ruleOnly.mode !== 'rule_only' || ruleOnly.ai !== undefined) {
    throw new Error('The B0 configuration must be mode rule_only without an ai block');
  }
  if (withAi.mode !== 'rules_with_external_ai' || withAi.aiConfigInvalid || !withAi.ai) {
    throw new Error('The B2 configuration must be a valid mode rules_with_external_ai');
  }
  if (
    !sameJson(ruleOnly.rules, withAi.rules) ||
    !sameJson(ruleOnly.thresholds, withAi.thresholds)
  ) {
    throw new Error('The rules and thresholds of B0 and B2 differ: B2 must add only the AI');
  }
  const ai = withAi.ai;
  const { medium } = ruleOnly.thresholds;

  const known = new Set(events.map(event => event.transferId));
  for (const id of options.capture.keys()) {
    if (!known.has(id)) throw new Error(`Capture has a txId that is not in the CSV: ${id}`);
  }
  const missing = events.filter(event => !options.capture.has(event.transferId));
  if (options.requireFullCapture && missing.length > 0) {
    throw new Error(
      `Capture is missing ${missing.length} transfer(s), first: ${missing[0].transferId}`,
    );
  }

  const provider = new OfflineFeatureProvider(facts, OFFLINE_PER_TX_LIMIT);
  const scoring = new ScoringService();
  const aiConfig = {
    mode: 'rules_with_external_ai',
    thresholds: ruleOnly.thresholds,
    rules: ruleOnly.rules,
    ai: { threshold: ai.threshold, weight: ai.weight },
  };

  const rows: Row[] = [];
  for (const event of events) {
    const line = options.capture.get(event.transferId);
    if (!line) continue;
    const features = await provider.extract(event);
    const baseline = scoring.score(event, features, { ...ruleOnly, mode: 'rule_only' });
    if (baseline === null) throw new Error(`Not a TRANSFER: ${event.transferId}`);
    const result = scoring.applyAssessment(
      { mode: 'rules_with_external_ai', hits: baseline.hits, ruleScore: baseline.ruleScore },
      aiConfig,
      line.assessment,
    );
    const hits: Partial<Record<RuleId, number>> = {};
    for (const hit of baseline.hits) hits[hit.id] = hit.weight;
    rows.push({
      customer: event.fromUserId,
      fraud: labels.get(event.transferId) === '1',
      scenario: scenarios.get(event.transferId) ?? 'UNKNOWN',
      weight: line.sampleWeight,
      ruleScore: baseline.ruleScore,
      hits,
      aiApplied: result.aiAppliedWeight,
      probability:
        line.assessment.status === 'SUCCEEDED' && line.assessment.probability !== null
          ? line.assessment.probability
          : null,
      b2Level: result.level,
    });
  }
  if (rows.length === 0) throw new Error('The capture has no transfer to measure');

  const flagB0: Flag = row => row.ruleScore >= medium;
  const flagB1: Flag = row => row.probability !== null && row.probability >= ai.threshold;
  const flagB2: Flag = row => row.b2Level !== 'LOW';
  const modes = {
    b0: metricsOf(rows, flagB0),
    b1: metricsOf(rows, flagB1),
    b2: metricsOf(rows, flagB2),
  };

  // Per scenario: fraud rows have weight 1 in every capture, so counts are rows.
  const scenarioNames = [...new Set(rows.filter(r => r.fraud).map(r => r.scenario))].sort();
  const byScenario: ScenarioRecall[] = scenarioNames.map(scenario => {
    const fraud = rows.filter(r => r.fraud && r.scenario === scenario);
    const rate = (flag: Flag): number => round(fraud.filter(flag).length / fraud.length);
    return {
      scenario,
      inScope: IN_SCOPE_SCENARIOS.includes(scenario),
      fraud: fraud.length,
      b0: rate(flagB0),
      b1: rate(flagB1),
      b2: rate(flagB2),
    };
  });

  // Ablation: take one rule's weight out of the score of B0 and of B2 and flag again.
  const ablate = (base: ModeMetrics, flag: Flag): AblationPoint => {
    const m = metricsOf(rows, flag);
    return {
      recall: m.recall,
      inScopeRecall: m.inScopeRecall,
      alertsPer1000: m.alertsPer1000,
      deltaRecall: round((m.recall ?? 0) - (base.recall ?? 0)),
      deltaAlertsPer1000: round(m.alertsPer1000 - base.alertsPer1000, 4),
    };
  };
  const without = (row: Row, rule: RuleId): number => row.hits[rule] ?? 0;
  const ablation = {
    rules: RULE_IDS.map(rule => ({
      rule,
      b0: ablate(modes.b0, row => row.ruleScore - without(row, rule) >= medium),
      b2: ablate(modes.b2, row => row.ruleScore - without(row, rule) + row.aiApplied >= medium),
    })),
    b2WithoutAi: ablate(modes.b2, row => row.ruleScore >= medium),
  };

  const scoreB0 = (row: Row): number => row.ruleScore;
  const scoreB1 = (row: Row): number => row.probability ?? -Infinity;
  const scoreB2 = (row: Row): number => row.ruleScore + row.aiApplied;
  const curves = {
    b0: curve(rows, scoreB0, distinct(rows.map(scoreB0))),
    b1: curve(rows, scoreB1, distinct([...B1_GRID, ai.threshold])),
    b2: curve(rows, scoreB2, distinct(rows.map(scoreB2))),
    averagePrecision: {
      b0: averagePrecision(rows, scoreB0),
      b1: averagePrecision(rows, scoreB1),
      b2: averagePrecision(rows, scoreB2),
    },
  };

  // Paired bootstrap by customer: a customer's rows share history, so they are drawn together.
  interface Cell {
    w: number;
    a0: number;
    a2: number;
    f: number;
    f0: number;
    f2: number;
    sf: number;
    sf0: number;
    sf2: number;
  }
  const cells = new Map<string, Cell>();
  for (const row of rows) {
    const cell = cells.get(row.customer) ?? {
      w: 0,
      a0: 0,
      a2: 0,
      f: 0,
      f0: 0,
      f2: 0,
      sf: 0,
      sf0: 0,
      sf2: 0,
    };
    const f0 = flagB0(row);
    const f2 = flagB2(row);
    cell.w += row.weight;
    if (f0) cell.a0 += row.weight;
    if (f2) cell.a2 += row.weight;
    if (row.fraud) {
      cell.f += row.weight;
      if (f0) cell.f0 += row.weight;
      if (f2) cell.f2 += row.weight;
      if (IN_SCOPE_SCENARIOS.includes(row.scenario)) {
        cell.sf += row.weight;
        if (f0) cell.sf0 += row.weight;
        if (f2) cell.sf2 += row.weight;
      }
    }
    cells.set(row.customer, cell);
  }
  const customers = [...cells.values()];
  const sum = (picked: readonly Cell[]): Cell =>
    picked.reduce(
      (acc, c) => {
        for (const key of Object.keys(acc) as (keyof Cell)[]) acc[key] += c[key];
        return acc;
      },
      { w: 0, a0: 0, a2: 0, f: 0, f0: 0, f2: 0, sf: 0, sf0: 0, sf2: 0 },
    );
  const statistics = (t: Cell) => ({
    gain: t.f === 0 ? null : (t.f2 - t.f0) / t.f,
    scopeGain: t.sf === 0 ? null : (t.sf2 - t.sf0) / t.sf,
    alerts0: t.w === 0 ? null : (t.a0 / t.w) * 1000,
    alerts2: t.w === 0 ? null : (t.a2 / t.w) * 1000,
  });
  const point = statistics(sum(customers));
  const random = prng(`${options.bootstrapSeed}:holdout-bootstrap`);
  const draws = {
    gain: [] as number[],
    scopeGain: [] as number[],
    alerts0: [] as number[],
    alerts2: [] as number[],
    alertsDiff: [] as number[],
  };
  for (let i = 0; i < iterations; i++) {
    const picked: Cell[] = [];
    for (let k = 0; k < customers.length; k++) {
      picked.push(customers[Math.floor(random() * customers.length)]);
    }
    const s = statistics(sum(picked));
    if (s.gain !== null) draws.gain.push(s.gain);
    if (s.scopeGain !== null) draws.scopeGain.push(s.scopeGain);
    if (s.alerts0 !== null && s.alerts2 !== null) {
      draws.alerts0.push(s.alerts0);
      draws.alerts2.push(s.alerts2);
      draws.alertsDiff.push(s.alerts2 - s.alerts0);
    }
  }
  const interval = (pointValue: number | null, values: number[], digits = 6): Interval => {
    values.sort((a, b) => a - b);
    return {
      point: round(pointValue ?? 0, digits),
      low: round(percentile(values, 0.025), digits),
      high: round(percentile(values, 0.975), digits),
    };
  };
  const bootstrap = {
    iterations,
    seed: options.bootstrapSeed,
    recallGain: {
      overall: interval(point.gain, draws.gain),
      inScope: interval(point.scopeGain, draws.scopeGain),
    },
    alertsPer1000: {
      b0: interval(point.alerts0, draws.alerts0, 4),
      b2: interval(point.alerts2, draws.alerts2, 4),
      difference: interval(
        point.alerts0 === null || point.alerts2 === null ? null : point.alerts2 - point.alerts0,
        draws.alertsDiff,
        4,
      ),
    },
  };

  // Provenance and cost come from every captured answer.
  const lines = [...options.capture.values()];
  const statusCounts: Record<string, number> = {};
  const providers = new Set<string>();
  const requestedModels = new Set<string>();
  const responseModels = new Set<string>();
  const rubrics = new Set<string>();
  let inputTokens = 0;
  let calls = 0;
  const latencies: number[] = [];
  for (const line of lines) {
    const a = line.assessment;
    statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
    if (a.provider) providers.add(a.provider);
    if (a.requestedModel) requestedModels.add(a.requestedModel);
    if (a.responseModel) responseModels.add(a.responseModel);
    if (a.rubricSha256) rubrics.add(a.rubricSha256);
    inputTokens += a.usage?.inputTokens ?? 0;
    calls += line.attempts;
    latencies.push(line.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  const usd = (inputTokens * price) / 1_000_000;

  const gain = bootstrap.recallGain.overall;
  const items: GateItem[] = [
    {
      name: 'Recall gain of B2 over B0 >= 5 points and the 95% paired bootstrap interval excludes 0',
      status: gain.point >= RECALL_GAIN_TARGET && gain.low > 0 ? 'pass' : 'fail',
      detail: `${(gain.point * 100).toFixed(2)} points, 95% interval [${(gain.low * 100).toFixed(2)}, ${(gain.high * 100).toFixed(2)}] (whole file, customers resampled)`,
    },
    {
      name: 'Pooled recall >= 70% on the 5 in-scope scenarios (B2)',
      status: (modes.b2.inScopeRecall ?? 0) >= IN_SCOPE_RECALL_TARGET ? 'pass' : 'fail',
      detail: `${((modes.b2.inScopeRecall ?? 0) * 100).toFixed(2)}% (B0 ${((modes.b0.inScopeRecall ?? 0) * 100).toFixed(2)}%)`,
    },
    {
      name: `<= ${ALERT_BUDGET_PER_1000} flags per 1 000 TRANSFER (B2)`,
      status: modes.b2.alertsPer1000 <= ALERT_BUDGET_PER_1000 ? 'pass' : 'fail',
      detail: `${modes.b2.alertsPer1000} per 1 000, 95% interval [${bootstrap.alertsPer1000.b2.low}, ${bootstrap.alertsPer1000.b2.high}] (B0 ${modes.b0.alertsPer1000})`,
    },
    {
      name: 'p95 transfer-to-flag < 5 s at 120 RPS (B0 and B2)',
      status: 'not-measured',
      detail:
        'a load test of the running system, not an offline measurement: see the DBS-174 reports 06 and 07',
    },
  ];
  const verdict = items.some(item => item.status === 'fail') ? 'NO-GO' : 'INCOMPLETE';

  const leakageWarnings: string[] = [];
  for (const entry of byScenario) {
    if (entry.inScope || entry.fraud < OUT_OF_SCOPE_MIN_FRAUD) continue;
    const best = Math.max(entry.b0, entry.b2);
    if (best > OUT_OF_SCOPE_SUSPECT_RECALL) {
      leakageWarnings.push(
        `Out-of-scope scenario ${entry.scenario} is caught at ${(best * 100).toFixed(1)}% (n=${entry.fraud}): no rule or feature covers it, check for label leakage before using any number`,
      );
    }
  }
  for (const [label, value] of [
    ['B0', modes.b0.inScopeRecall],
    ['B2', modes.b2.inScopeRecall],
  ] as const) {
    if (value !== null && value >= 0.95) {
      leakageWarnings.push(
        `${label} in-scope recall is ${(value * 100).toFixed(1)}%: unusually high, check for label leakage before using it`,
      );
    }
  }
  const failed = lines.filter(line => line.assessment.status !== 'SUCCEEDED').length;
  if (lines.length > 0 && failed / lines.length > MAX_FAILED_AI_SHARE) {
    leakageWarnings.push(
      `${failed} of ${lines.length} AI answers did not succeed (${statusCounts.UNAVAILABLE ?? 0} UNAVAILABLE): B1 and B2 are measured with those transfers unscored, re-capture only with a decision of the team`,
    );
  }

  return {
    parameters: {
      ruleOnlyVersion: options.ruleOnly.version,
      withAiVersion: options.withAi.version,
      thresholds: ruleOnly.thresholds,
      ai: { model: ai.model, threshold: ai.threshold, weight: ai.weight },
    },
    sample: {
      transfers: rows.length,
      fraud: rows.filter(row => row.fraud).length,
      customers: customers.length,
      fullCapture: missing.length === 0 && rows.every(row => row.weight === 1),
    },
    modes,
    byScenario,
    ablation,
    curves,
    bootstrap,
    provenance: {
      providers: [...providers].sort(),
      requestedModels: [...requestedModels].sort(),
      responseModels: [...responseModels].sort(),
      rubricSha256: [...rubrics].sort(),
      statusCounts: Object.fromEntries(
        Object.entries(statusCounts).sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    },
    cost: {
      calls,
      inputTokens,
      usd: round(usd, 4),
      assumption: `input tokens x $${price}/1M, output not billed; an estimate, not an invoice`,
      callLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    },
    gate: { items, verdict },
    leakageWarnings,
  };
}
