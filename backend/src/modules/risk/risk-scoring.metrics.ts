import { Counter, register } from 'prom-client';
import type { AiStatus } from './ai/ai-contract';
import type { RuleId } from './rules/rule';

/**
 * The counters of the scoring half of risk (BL-204, BL-207, BL-046). `MetricsService` turns them
 * into CloudWatch metrics (`DBS/Backend`): the label `rule` becomes the dimension `Rule`, the label
 * `ai_status` becomes `AiStatus`. Neither can hold data about a person: a value outside the fixed
 * sets below is written as `unknown`, so a bug cannot put an id or an amount on a metric.
 */
export const RULE_ERROR_METRIC = 'risk_rule_error_total';
export const DECISION_METRIC = 'risk_decision_total';

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

/** One failed evaluation of rule `rule` (every receive of a failing message counts once). */
export function countRuleError(rule: RuleId): void {
  ruleErrors.inc({ rule: RULE_IDS.includes(rule) ? rule : UNKNOWN });
}

/** One decision recorded by the delivery that won the claim of its transfer. */
export function countDecision(aiStatus: AiStatus): void {
  decisions.inc({ ai_status: AI_STATUSES.includes(aiStatus) ? aiStatus : UNKNOWN });
}
