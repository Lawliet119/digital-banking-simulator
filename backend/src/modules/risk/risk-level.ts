export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * The one rule that turns a score into a level. `ScoringService` and the flag metric (DBS-187) both
 * use it, so the metric can never disagree with `fraud_flags.risk_level`. No imports on purpose: the
 * scoring service and the metrics module can both depend on it without a cycle.
 */
export function levelOf(score: number, thresholds: { medium: number; high: number }): RiskLevel {
  return score >= thresholds.high ? 'HIGH' : score >= thresholds.medium ? 'MEDIUM' : 'LOW';
}
