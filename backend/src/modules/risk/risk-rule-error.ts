import type { RuleId } from './rules/rule';

/**
 * A rule threw, or returned something the scoring service refuses (BL-207 f, ADR-14). It is the
 * same failure the consumer already handled: nothing is written, the message is not acknowledged,
 * it is retried and dead-lettered at the fifth receive. Wrapping only adds the id of the rule, so
 * `risk_rule_error_total{rule}` and the logs can say which one. The message holds no value (an
 * amount, an id) from the event; the original error stays in `cause`.
 */
export class RiskRuleError extends Error {
  override readonly name = 'RiskRuleError';

  constructor(
    readonly ruleId: RuleId,
    reason: 'threw' | 'invalid result',
    options?: { cause?: unknown },
  ) {
    super(`Risk rule ${ruleId} ${reason}`, options);
  }
}
