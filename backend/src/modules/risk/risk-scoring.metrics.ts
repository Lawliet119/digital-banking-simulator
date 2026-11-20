import { Counter, register } from 'prom-client';
import type { AiStatus } from './ai/ai-contract';
import { levelOf, type RiskLevel } from './risk-level';
import type { RuleId } from './rules/rule';

/**
 * The counters of the scoring half of risk (BL-204, BL-207, BL-046). `MetricsService` turns them
 * into CloudWatch metrics (`DBS/Backend`): the label `rule` becomes the dimension `Rule`, the label
 * `ai_status` becomes `AiStatus`. Neither can hold data about a person: a value outside the fixed
 * sets below is written as `unknown`, so a bug cannot put an id or an amount on a metric.
 */
export const RULE_ERROR_METRIC = 'risk_rule_error_total';
export const DECISION_METRIC = 'risk_decision_total';
/** DBS-187: one increment per fraud flag written; labels risk_level, mode and ai_added (all from fixed sets). */
export const FLAG_METRIC = 'risk_flag_total';

const RULE_IDS: readonly RuleId[] = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'];
/**
 * Every value of `risk_decisions.ai_status`. `DISABLED` is also what a `rule_only` decision stores
 * (no AI requested), so it is the "AI not asked" bucket of the metric.
 */
export const AI_STATUSES: readonly AiStatus[] = [
  'DISABLED',
  'CONFIG_INVALID',
  'SUCCEEDED',
  'REFUSED',
  'INVALID_RESPONSE',
  'UNAVAILABLE',
  'BUDGET_EXHAUSTED',
];
const UNKNOWN = 'unknown';

function sharedCounter<L extends string>(name: string, help: string, label: L): Counter<L> {
  const existing = register.getSingleMetric(name);
  if (existing instanceof Counter) return existing;
  return new Counter({ name, help, labelNames: [label], registers: [register] });
}

const ruleErrors = sharedCounter(
  RULE_ERROR_METRIC,
  'Evaluations of a risk rule that threw or returned an invalid result',
  'rule',
);
const decisions = sharedCounter(
  DECISION_METRIC,
  'Risk decisions recorded, by the ai_status stored with the decision',
  'ai_status',
);

export type FlagLevel = Exclude<RiskLevel, 'LOW'>;
export type FlagMode = 'rule_only' | 'rules_with_external_ai';
/**
 * How the AI took part in a flag (DBS-187), from the level the rules alone would give and the final
 * one: `created` (rules alone LOW, so no flag without the AI), `raised` (rules alone MEDIUM, the AI made
 * it HIGH), `none` (the level did not change, also when the AI added points to an existing HIGH).
 */
export type AiAdded = 'none' | 'created' | 'raised';

const FLAG_LEVELS: readonly string[] = ['MEDIUM', 'HIGH'];
const FLAG_MODES: readonly string[] = ['rule_only', 'rules_with_external_ai'];
const AI_ADDED: readonly string[] = ['none', 'created', 'raised'];

const flags = (() => {
  const existing = register.getSingleMetric(FLAG_METRIC);
  if (existing instanceof Counter) return existing as Counter<'risk_level' | 'mode' | 'ai_added'>;
  return new Counter({
    name: FLAG_METRIC,
    help: 'Fraud flags written, by risk level, scoring mode and what the AI added',
    labelNames: ['risk_level', 'mode', 'ai_added'],
    registers: [register],
  });
})();

/** Pure: no label of this metric can hold more than these three values per label. */
export function classifyAiAdded(
  ruleScore: number,
  score: number,
  thresholds: { medium: number; high: number },
): AiAdded {
  const ruleLevel = levelOf(ruleScore, thresholds);
  const finalLevel = levelOf(score, thresholds);
  if (ruleLevel === 'LOW' && finalLevel !== 'LOW') return 'created';
  if (ruleLevel === 'MEDIUM' && finalLevel === 'HIGH') return 'raised';
  return 'none';
}

/** One flag written by the delivery that won the claim of its transfer (never LOW, never a duplicate). */
export function countFlag(level: FlagLevel, mode: FlagMode, aiAdded: AiAdded): void {
  flags.inc({
    risk_level: FLAG_LEVELS.includes(level) ? level : UNKNOWN,
    mode: FLAG_MODES.includes(mode) ? mode : UNKNOWN,
    ai_added: AI_ADDED.includes(aiAdded) ? aiAdded : UNKNOWN,
  });
}

/** One failed evaluation of rule `rule` (every receive of a failing message counts once). */
export function countRuleError(rule: RuleId): void {
  ruleErrors.inc({ rule: RULE_IDS.includes(rule) ? rule : UNKNOWN });
}

/** One decision recorded by the delivery that won the claim of its transfer. */
export function countDecision(aiStatus: AiStatus): void {
  decisions.inc({ ai_status: AI_STATUSES.includes(aiStatus) ? aiStatus : UNKNOWN });
}
