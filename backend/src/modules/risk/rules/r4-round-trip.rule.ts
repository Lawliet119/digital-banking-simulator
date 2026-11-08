import type { Features, TransferEvent } from '../features/feature-provider';
import type { RiskRule, RuleHit, RuleParams } from './rule';
import { riskTimeNanoseconds } from '../risk-time';

const MINUTE_NS = 60_000_000_000n;

/** Evaluate a reverse-transfer fact supplied by the feature provider. */
export class R4RoundTripRule implements RiskRule {
  readonly id = 'R4' as const;

  evaluate(event: TransferEvent, features: Features, params: RuleParams): RuleHit | null {
    if ((event.type as string) !== 'TRANSFER') return null;
    const window = params.thresholds?.reverseWindowMinutes;
    if (
      typeof params.enabled !== 'boolean' ||
      !Number.isInteger(params.weight) ||
      params.weight < 0 ||
      params.weight > 2_147_483_647 ||
      typeof window !== 'number' ||
      !Number.isSafeInteger(window) ||
      window < 1 ||
      window > 60
    )
      throw new Error('Invalid R4 configuration');
    const occurredAt = riskTimeNanoseconds(event.occurredAt);
    const reverse = features.reverseTransferOccurredAt;
    if (reverse === null) return null;
    const elapsed = occurredAt - riskTimeNanoseconds(reverse);
    if (!params.enabled || elapsed <= 0n || elapsed > BigInt(window) * MINUTE_NS) return null;
    const hundredths = (elapsed * 100n) / MINUTE_NS;
    const minutes =
      hundredths === 0n
        ? 'chưa đến 0.01'
        : `khoảng ${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
    return {
      id: this.id,
      weight: params.weight,
      explanation: `Tài khoản đích đã chuyển ngược lại ${minutes} phút trước.`,
    };
  }
}
