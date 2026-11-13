import { randomUUID } from 'node:crypto';

type Runner = { query(sql: string, args?: unknown[]): Promise<unknown> };

/**
 * BL-223: decision, flag and hits that satisfy the commit-time invariants (rule_score = sum of the
 * hit weights, flag score = rule_score, level from the thresholds of the rule-set version), written
 * by ONE statement so it also works on a connection in autocommit: the constraint triggers are
 * deferred to the end of that statement's implicit transaction. Default hit: one R1 with the whole
 * score. A fixture that needs another shape is written as an explicit transaction instead.
 */
export async function insertFlaggedDecision(
  runner: Runner,
  transferId: string,
  options: {
    score: number;
    level: 'MEDIUM' | 'HIGH';
    version?: number;
    eventId?: string;
    hits?: [rule: string, weight: number][];
  },
): Promise<void> {
  const hits = options.hits ?? [['R1', options.score]];
  const total = hits.reduce((sum, [, weight]) => sum + weight, 0);
  if (total !== options.score) throw new Error('Fixture hits must add up to the score');
  await runner.query(
    `WITH d AS (
       INSERT INTO risk_decisions
         (transfer_id, event_id, rule_set_version, mode, rule_score, feature_snapshot, ai_status, ai_applied_weight)
       VALUES ($1, $2, $3, 'rule_only', $4, '{}'::jsonb, 'DISABLED', 0) RETURNING 1),
     f AS (
       INSERT INTO fraud_flags(transfer_id, score, risk_level, rule_set_version)
       VALUES ($1, $4, $5, $3) RETURNING 1),
     h AS (
       INSERT INTO fraud_rule_hits(transfer_id, rule_id, weight, explanation)
       SELECT $1, x.rule_id, x.weight, 'fixture' FROM jsonb_to_recordset($6::jsonb) AS x(rule_id text, weight int)
       RETURNING 1)
     SELECT (SELECT count(*) FROM d) + (SELECT count(*) FROM f) + (SELECT count(*) FROM h)`,
    [
      transferId,
      options.eventId ?? randomUUID(),
      options.version ?? 1,
      options.score,
      options.level,
      JSON.stringify(hits.map(([rule_id, weight]) => ({ rule_id, weight }))),
    ],
  );
}

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
