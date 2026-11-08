import type { RuleId, RuleParams } from '../rules/rule';
import type { ScoringConfig } from '../scoring.service';

/** PostgreSQL `int` maximum: a flag's score, and so the sum of all weights, must fit it. */
const MAX_SCORE = 2_147_483_647;
const RULE_IDS: readonly RuleId[] = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'];
const MODEL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_RUBRIC_LENGTH = 4000;

/** A rule set that cannot be used. The text names the field, never the value. */
export class InvalidRuleSetError extends Error {
  constructor(readonly field: string) {
    super(`Invalid risk rule set: ${field}`);
    this.name = 'InvalidRuleSetError';
  }
}

/** The `ai.*` block of a version (ADR-14); only read when `mode` is `rules_with_external_ai`. */
export interface AiConfig {
  readonly provider: 'openai';
  readonly model: string;
  readonly rubric: string;
  /** In (0, 1]: the lowest probability that adds the weight. */
  readonly threshold: number;
  /** Whole number >= 0 added to the score when the answer reaches the threshold. */
  readonly weight: number;
  readonly maxAdmissionDelayMs: number;
  readonly requestTimeoutMs: number;
}

/** One immutable version of the rule configuration, ready for `ScoringService`. */
export interface RuleSet extends ScoringConfig {
  readonly version: number;
  readonly mode: string;
  readonly ai?: AiConfig;
  /**
   * True when `mode` asks for AI but the `ai.*` block is unusable: the rules still score and the
   * decision records `CONFIG_INVALID` (ADR-14), the event is not sent to the DLQ.
   */
  readonly aiConfigInvalid: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

function parseRule(id: RuleId, raw: unknown): RuleParams {
  if (!isObject(raw)) throw new InvalidRuleSetError(`rules.${id}`);
  const { enabled, weight, ...rest } = raw;
  if (typeof enabled !== 'boolean') throw new InvalidRuleSetError(`rules.${id}.enabled`);
  if (!isCount(weight, 0, MAX_SCORE)) throw new InvalidRuleSetError(`rules.${id}.weight`);
  const thresholds: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (key === 'sameOwnerExempt') {
      // Fixed in R5 and R6 code (guide §4.2); a version cannot switch the exemption off.
      if (value !== true) throw new InvalidRuleSetError(`rules.${id}.${key}`);
      continue;
    }
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
      thresholds[key] = value;
    else throw new InvalidRuleSetError(`rules.${id}.${key}`);
  }
  return { enabled, weight, thresholds };
}

function parseAi(raw: unknown, ruleScoreCeiling: number): AiConfig | undefined {
  if (!isObject(raw)) return undefined;
  const { provider, model, rubric, threshold, weight, maxAdmissionDelayMs, requestTimeoutMs } = raw;
  if (
    provider !== 'openai' ||
    typeof model !== 'string' ||
    !MODEL_NAME.test(model) ||
    typeof rubric !== 'string' ||
    rubric.trim().length === 0 ||
    rubric.length > MAX_RUBRIC_LENGTH ||
    typeof threshold !== 'number' ||
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    threshold > 1 ||
    !isCount(weight, 0, MAX_SCORE - ruleScoreCeiling) ||
    !isCount(maxAdmissionDelayMs, 1, 2_147_483_647) ||
    !isCount(requestTimeoutMs, 1, 2_147_483_647)
  )
    return undefined;
  return { provider, model, rubric, threshold, weight, maxAdmissionDelayMs, requestTimeoutMs };
}

/**
 * Turns the JSON of a `risk_rule_sets` row into a {@link RuleSet}. The row keeps each rule's
 * numbers flat next to `enabled` and `weight` (the seed of DBS-58); the rules read them from
 * `thresholds`, so everything but those two moves there.
 *
 * Strict for the baseline (thresholds, weights, every rule present): a version that fails is an
 * error, handled like a rule fault by the consumer. Lenient for `ai.*`: it only ever adds to the
 * score, so a broken block leaves the rules scoring and sets {@link RuleSet.aiConfigInvalid}.
 */
export function parseRuleSet(version: number, raw: unknown): RuleSet {
  if (!isCount(version, 1, MAX_SCORE)) throw new InvalidRuleSetError('version');
  if (!isObject(raw)) throw new InvalidRuleSetError('config');
  const levels = raw.thresholds;
  if (!isObject(levels)) throw new InvalidRuleSetError('thresholds');
  const { medium, high } = levels;
  if (!isCount(medium, 1, MAX_SCORE) || !isCount(high, 1, MAX_SCORE) || high <= medium)
    throw new InvalidRuleSetError('thresholds');
  if (!isObject(raw.rules)) throw new InvalidRuleSetError('rules');

  const rules = {} as Record<RuleId, RuleParams>;
  let ruleScoreCeiling = 0;
  for (const id of RULE_IDS) {
    rules[id] = parseRule(id, raw.rules[id]);
    ruleScoreCeiling += rules[id].weight;
  }
  if (ruleScoreCeiling > MAX_SCORE) throw new InvalidRuleSetError('rules.weight');

  const mode = raw.mode === undefined ? 'rule_only' : raw.mode;
  if (typeof mode !== 'string') throw new InvalidRuleSetError('mode');
  const wantsAi = mode === 'rules_with_external_ai';
  const ai = wantsAi ? parseAi(raw.ai, ruleScoreCeiling) : undefined;
  return {
    version,
    mode,
    thresholds: { medium, high },
    rules,
    ...(ai ? { ai } : {}),
    aiConfigInvalid: wantsAi && ai === undefined,
  };
}
