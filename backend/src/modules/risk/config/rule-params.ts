import type { Features, TransferEvent } from '../features/feature-provider';
import { R1VelocityRule } from '../rules/r1-velocity.rule';
import { R2UnusualAmountRule } from '../rules/r2-unusual-amount.rule';
import { R3NewAccountLargeTransferRule } from '../rules/r3-new-account-large-transfer.rule';
import { R4RoundTripRule } from '../rules/r4-round-trip.rule';
import { R5FanOutRule } from '../rules/r5-fan-out.rule';
import { R6DrainRule } from '../rules/r6-drain.rule';
import type { RiskRule, RuleId, RuleParams } from '../rules/rule';

/**
 * The same rule objects that score events. A rule validates its own parameters before it looks at
 * the data, so the per-rule domain (required keys, string money, ranges) lives in one place: the
 * rule. `Record<RuleId, ...>` makes a seventh rule a compile error here until it is listed.
 */
const RULES: Readonly<Record<RuleId, RiskRule>> = {
  R1: new R1VelocityRule(),
  R2: new R2UnusualAmountRule(),
  R3: new R3NewAccountLargeTransferRule(),
  R4: new R4RoundTripRule(),
  R5: new R5FanOutRule(),
  R6: new R6DrainRule(),
};

// A valid synthetic transfer and facts: only the parameters can make a rule throw.
const PROBE_EVENT: TransferEvent = {
  eventType: 'TransferCompleted',
  eventId: '00000000-0000-4000-8000-000000000001',
  correlationId: '00000000-0000-4000-8000-000000000002',
  transferId: '00000000-0000-4000-8000-000000000003',
  fromAccountId: '00000000-0000-4000-8000-000000000004',
  toAccountId: '00000000-0000-4000-8000-000000000005',
  fromUserId: '00000000-0000-4000-8000-000000000006',
  toUserId: '00000000-0000-4000-8000-000000000007',
  type: 'TRANSFER',
  amount: '1',
  fromBalanceBefore: '1',
  sameOwner: false,
  occurredAt: '2026-01-02T00:00:00.000Z',
  fromAccountCreatedAt: '2026-01-01T00:00:00.000Z',
  toAccountCreatedAt: '2026-01-01T00:00:00.000Z',
};
const PROBE_FEATURES: Features = {
  txCount10m: 1,
  txCount1h: 1,
  historyCount30d: 0,
  medianAmount30dTimes2: null,
  reverseTransferOccurredAt: null,
  newRecipients1h: 1,
  distinctRecipients24h: 1,
  sumOut24h: '1',
  smallTxCount24h: 1,
};

/**
 * Runs every rule on a synthetic transfer and returns the id of the first rule that rejects its
 * parameters, or `undefined` when all accept them. Used by `parseRuleSet` (read path) and by the
 * UC-12 create path, so a version the API accepts is a version the worker accepts.
 *
 * Each rule is probed as `enabled`: a rule that skipped its checks while switched off would
 * otherwise let a broken value in, to fail the day somebody switches the rule on.
 */
export function firstRuleRejectingParams(
  rules: Readonly<Record<RuleId, RuleParams>>,
): RuleId | undefined {
  for (const id of Object.keys(RULES) as RuleId[]) {
    try {
      RULES[id].evaluate(PROBE_EVENT, PROBE_FEATURES, { ...rules[id], enabled: true });
    } catch {
      return id;
    }
  }
  return undefined;
}
