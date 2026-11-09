import { randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';

type Runner = Pick<QueryRunner, 'query'>;

/**
 * RSK-01: a flag needs a decision for the same (transfer_id, rule_set_version). Tests that write
 * flags directly insert this `rule_only` decision first. The row is append-only: it can never be
 * deleted, so commit it only where that is acceptable (a throwaway database or container).
 */
export async function insertRuleOnlyDecision(
  runner: Runner,
  transferId: string,
  options: { version?: number; eventId?: string; ruleScore?: number } = {},
): Promise<void> {
  await runner.query(
    `INSERT INTO risk_decisions
       (transfer_id, event_id, rule_set_version, mode, rule_score, feature_snapshot, ai_status, ai_applied_weight)
     VALUES ($1, $2, $3, 'rule_only', $4, '{}'::jsonb, 'DISABLED', 0)`,
    [transferId, options.eventId ?? randomUUID(), options.version ?? 1, options.ruleScore ?? 0],
  );
}
