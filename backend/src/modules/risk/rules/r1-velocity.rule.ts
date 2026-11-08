import type { Features, TransferEvent } from '../features/feature-provider';
import type { RiskRule, RuleHit, RuleParams } from './rule';

const WINDOW_MINUTES = 10;
const MAX_WEIGHT = 2147483647;

/** Evaluates the provider's point-in-time, deduplicated 10-minute transfer count. */
export class R1VelocityRule implements RiskRule {
  readonly id = 'R1' as const;

  evaluate(event: TransferEvent, features: Features, params: RuleParams): RuleHit | null {
    // The type says TRANSFER and the consumer filters, but a DEPOSIT must never be scored even if
    // one slips through at runtime (DBS-93 DoD 3). Checked first: a deposit has no count to judge.
    if ((event.type as string) !== 'TRANSFER') return null;

    const { maxTransfers, windowMinutes } = params.thresholds;
    const count = features.txCount10m;
    if (
      typeof params.enabled !== 'boolean' ||
      !Number.isInteger(params.weight) ||
      params.weight < 0 ||
      params.weight > MAX_WEIGHT ||
      typeof maxTransfers !== 'number' ||
      !Number.isSafeInteger(maxTransfers) ||
      maxTransfers < 0 ||
      windowMinutes !== WINDOW_MINUTES ||
      !Number.isSafeInteger(count) ||
      count < 1
    ) {
      throw new Error('Invalid R1 velocity input or configuration');
    }

    if (!params.enabled || count <= maxTransfers) return null;
    return {
      id: this.id,
      weight: params.weight,
      explanation: `${count} lệnh chuyển trong ${WINDOW_MINUTES} phút (ngưỡng ${maxTransfers})`,
    };
  }
}
