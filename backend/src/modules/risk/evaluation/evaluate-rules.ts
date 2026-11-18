import { createHash } from 'node:crypto';
import type { AiAssessment } from '../ai/ai-contract';
import { parseRuleSet } from '../config/rule-set';
import { parseTransactionCsv } from '../features/export-features';
import { OfflineFeatureProvider } from '../features/offline-feature-provider';
import { ScoringService } from '../scoring.service';
import { partOf, type SplitPart } from './customer-split';

/**
 * Offline quality measurement of the rules (DBS-132, FRAUD guide §6.3): reads the 12-column tune
 * CSV, scores every transfer with the same `ScoringService` the worker uses and reports the
 * confusion matrix and the metrics of the guide.
 *
 * A transfer is "flagged" when its level is MEDIUM or HIGH (score >= `thresholds.medium`), the
 * same condition that creates a `fraud_flags` row. The AI answer is never requested here: B2 reads
 * a capture saved earlier (one capture is shared by B1 and B2, ADR-14), so a run cannot spend money.
 */

/** Same value and reason as `export-features`: no rule R1–R6 reads it, it is not the platform limit. */
const OFFLINE_PER_TX_LIMIT = 500_000_000n;

/** Fraud scenarios the rules are meant to catch (guide §6.4); the other three are reported apart. */
export const IN_SCOPE_SCENARIOS: readonly string[] = [
  'ATO_DRAIN',
  'MULE_FANOUT',
  'VELOCITY_BURST',
  'BUST_OUT',
  'ROUND_TRIP',
];

export interface EvaluateOptions {
  readonly csvText: string;
  /** JSON of a `risk_rule_sets.config` row. */
  readonly config: unknown;
  readonly configVersion: number;
  /** Only echoed in the report: the CSV does not carry its generator seed. */
  readonly seed?: string;
  /** AI answers by tx_id; required for `rules_with_external_ai`, refused for `rule_only`. */
  readonly capture?: ReadonlyMap<string, AiAssessment>;
  /** Evaluate only the transfers present in the capture (history still comes from the whole CSV). */
  readonly restrictToCapture?: boolean;
  /**
   * Measure only one part of the customer split (DBS-161): needs `seed`. History for the rules still
   * comes from the whole CSV, so a rule sees the same past as in production.
   */
  readonly part?: SplitPart;
}

export interface Metrics {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly falsePositiveRate: number | null;
  readonly alertsPer1000: number;
}

export interface ScenarioRecall {
  readonly fraud: number;
  readonly caught: number;
  readonly recall: number;
}

export interface EvaluationReport {
  readonly configVersion: number;
  readonly mode: string;
  readonly thresholds: { readonly medium: number; readonly high: number };
  readonly seed: string | null;
  /** Which part of the customer split was measured; null = the whole file. */
  readonly part: SplitPart | null;
  readonly csvSha256: string;
  readonly transactions: number;
  readonly frauds: number;
  readonly metrics: Metrics;
  /** B0 on the same transfers, only when the run is B2: the paired baseline. */
  readonly baseline: Metrics | null;
  readonly byScenario: Readonly<Record<string, ScenarioRecall>>;
  /** Recall pooled over {@link IN_SCOPE_SCENARIOS}: the target of NFR-FRD-02. */
  readonly inScopeRecall: ScenarioRecall;
  /** Hard negatives (legitimate look-alikes): how many were flagged. */
  readonly hardNegatives: Readonly<Record<string, { rows: number; flagged: number }>>;
  readonly ai: {
    readonly model: string;
    readonly threshold: number;
    readonly weight: number;
    readonly rubricSha256: readonly string[];
    readonly responseModels: readonly string[];
    readonly statusCounts: Readonly<Record<string, number>>;
    readonly captured: number;
  } | null;
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

function metricsOf(tp: number, fp: number, fn: number, tn: number): Metrics {
  const n = tp + fp + fn + tn;
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return {
    tp,
    fp,
    fn,
    tn,
    precision: precision === null ? null : round(precision),
    recall: recall === null ? null : round(recall),
    f1: f1 === null ? null : round(f1),
    falsePositiveRate: fp + tn === 0 ? null : round(fp / (fp + tn)),
    alertsPer1000: n === 0 ? 0 : round(((tp + fp) / n) * 1000),
  };
}

/** One JSON object per line: `{"txId": "...", "assessment": { ...AiAssessment }}`. */
export function parseCapture(text: string): Map<string, AiAssessment> {
  const capture = new Map<string, AiAssessment>();
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.trim().length === 0) return;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`Capture line ${index + 1}: not valid JSON`);
    }
    const { txId, assessment } = (row ?? {}) as { txId?: unknown; assessment?: unknown };
    if (typeof txId !== 'string' || txId.length === 0) {
      throw new Error(`Capture line ${index + 1}: txId must be a non-empty string`);
    }
    if (
      typeof assessment !== 'object' ||
      assessment === null ||
      typeof (assessment as { status?: unknown }).status !== 'string'
    ) {
      throw new Error(`Capture line ${index + 1}: assessment.status is required`);
    }
    if (capture.has(txId)) throw new Error(`Capture line ${index + 1}: duplicate txId`);
    capture.set(txId, assessment as AiAssessment);
  });
  return capture;
}

export async function evaluateRules(options: EvaluateOptions): Promise<EvaluationReport> {
  const { csvText, config, configVersion, capture } = options;
  const { facts, events, labels, scenarios } = parseTransactionCsv(csvText);
  if (![...labels.values()].includes('1')) {
    // A holdout or an unlabeled file must never be measured by accident (DBS-132).
    throw new Error('Refusing to run: no row has is_fraud=1 (labels missing or not a tune file)');
  }

  const ruleSet = parseRuleSet(configVersion, config);
  if (ruleSet.mode !== 'rule_only' && ruleSet.mode !== 'rules_with_external_ai') {
    throw new Error(`Unsupported mode '${ruleSet.mode}'`);
  }
  const wantsAi = ruleSet.mode === 'rules_with_external_ai';
  if (wantsAi) {
    if (!capture) throw new Error('Mode rules_with_external_ai needs --ai-capture (no live calls)');
    if (ruleSet.aiConfigInvalid || !ruleSet.ai) {
      throw new Error('Refusing to run: the ai.* block of the configuration is invalid');
    }
  } else if (capture || options.restrictToCapture) {
    throw new Error('--ai-capture and --restrict-to-capture need a rules_with_external_ai config');
  }

  const known = new Set(events.map(event => event.transferId));
  if (options.restrictToCapture) {
    for (const id of capture?.keys() ?? []) {
      if (!known.has(id)) throw new Error(`Capture has a txId that is not in the CSV: ${id}`);
    }
  }
  if (options.part && !options.seed) throw new Error('--part needs --seed (the split is seeded)');
  const inPart = (event: (typeof events)[number]): boolean =>
    !options.part || partOf(options.seed!, event.fromUserId) === options.part;
  const evaluated = (
    options.restrictToCapture ? events.filter(event => capture!.has(event.transferId)) : events
  ).filter(inPart);
  if (wantsAi) {
    const missing = evaluated.filter(event => !capture!.has(event.transferId));
    if (missing.length > 0) {
      throw new Error(
        `Capture is missing ${missing.length} transfer(s), first: ${missing[0].transferId}`,
      );
    }
  }
  if (evaluated.length === 0) throw new Error('Nothing to evaluate');

  const provider = new OfflineFeatureProvider(facts, OFFLINE_PER_TX_LIMIT);
  const scoring = new ScoringService();

  const counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const baseline = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const byScenario = new Map<string, { fraud: number; caught: number }>();
  const hardNegatives = new Map<string, { rows: number; flagged: number }>();
  const statusCounts: Record<string, number> = {};
  const rubrics = new Set<string>();
  const responseModels = new Set<string>();
  let frauds = 0;

  for (const event of evaluated) {
    const features = await provider.extract(event);
    const assessment = wantsAi ? capture!.get(event.transferId) : undefined;
    const result = scoring.score(event, features, ruleSet, assessment);
    if (result === null) throw new Error(`Not a TRANSFER: ${event.transferId}`);

    const fraud = labels.get(event.transferId) === '1';
    const flagged = result.level !== 'LOW';
    const baselineFlagged = result.ruleScore >= ruleSet.thresholds.medium;
    const bucket = (flag: boolean): 'tp' | 'fp' | 'fn' | 'tn' =>
      fraud ? (flag ? 'tp' : 'fn') : flag ? 'fp' : 'tn';
    counts[bucket(flagged)] += 1;
    baseline[bucket(baselineFlagged)] += 1;

    const scenario = scenarios.get(event.transferId) ?? 'UNKNOWN';
    if (fraud) {
      frauds += 1;
      const entry = byScenario.get(scenario) ?? { fraud: 0, caught: 0 };
      entry.fraud += 1;
      if (flagged) entry.caught += 1;
      byScenario.set(scenario, entry);
    } else if (scenario !== 'NORMAL') {
      const entry = hardNegatives.get(scenario) ?? { rows: 0, flagged: 0 };
      entry.rows += 1;
      if (flagged) entry.flagged += 1;
      hardNegatives.set(scenario, entry);
    }
    if (wantsAi) {
      statusCounts[result.aiStatus] = (statusCounts[result.aiStatus] ?? 0) + 1;
      if (assessment?.rubricSha256) rubrics.add(assessment.rubricSha256);
      if (assessment?.responseModel) responseModels.add(assessment.responseModel);
    }
  }

  const recallOf = (entry: { fraud: number; caught: number }): ScenarioRecall => ({
    fraud: entry.fraud,
    caught: entry.caught,
    recall: entry.fraud === 0 ? 0 : round(entry.caught / entry.fraud),
  });
  const sorted = <T>(map: Map<string, T>): [string, T][] =>
    [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const inScope = { fraud: 0, caught: 0 };
  for (const name of IN_SCOPE_SCENARIOS) {
    const entry = byScenario.get(name);
    if (entry) {
      inScope.fraud += entry.fraud;
      inScope.caught += entry.caught;
    }
  }

  const ai = ruleSet.ai;
  return {
    configVersion,
    mode: ruleSet.mode,
    thresholds: ruleSet.thresholds,
    seed: options.seed ?? null,
    part: options.part ?? null,
    csvSha256: createHash('sha256').update(csvText).digest('hex'),
    transactions: evaluated.length,
    frauds,
    metrics: metricsOf(counts.tp, counts.fp, counts.fn, counts.tn),
    baseline: wantsAi ? metricsOf(baseline.tp, baseline.fp, baseline.fn, baseline.tn) : null,
    byScenario: Object.fromEntries(sorted(byScenario).map(([k, v]) => [k, recallOf(v)])),
    inScopeRecall: recallOf(inScope),
    hardNegatives: Object.fromEntries(sorted(hardNegatives)),
    ai:
      wantsAi && ai
        ? {
            model: ai.model,
            threshold: ai.threshold,
            weight: ai.weight,
            rubricSha256: [...rubrics].sort(),
            responseModels: [...responseModels].sort(),
            statusCounts: Object.fromEntries(
              Object.entries(statusCounts).sort(([a], [b]) => (a < b ? -1 : 1)),
            ),
            captured: capture!.size,
          }
        : null,
  };
}
