import type { Features, TransferEvent } from '../features/feature-provider';
import type { RiskRule, RuleHit, RuleParams } from './rule';
import { riskTimeNanoseconds } from '../risk-time';
import { formatFixed2 } from './explanation-format';

const MINUTE_NS = 60_000_000_000n;

/**
 * Evaluate a reverse-transfer fact supplied by the feature provider.
 *
 * Resolution: the rule compares the instants exactly as given (nanoseconds), but the online provider
 * cuts both `occurredAt` and the reverse transfer to milliseconds, so end to end R4 is a
 * millisecond-resolution rule (BL-207(c)); the smallest elapsed time it can see is 1 ms.
 *
 * Policy (BL-207(a), (b)): a switched-off rule judges only its configuration, so it returns `null`
 * before it reads any provider data. An enabled rule that is handed a reverse transfer at or after
 * the event throws: the provider promises transfers strictly before `occurredAt`, so this is a
 * feature fault that ADR-14 sends to rollback and retry, the same way the AI projection treats it,
 * not a quiet "no reverse transfer".
 */
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
    if (!params.enabled) return null; // a switched-off rule does not judge the data
    const occurredAt = riskTimeNanoseconds(event.occurredAt);
    const reverse = features.reverseTransferOccurredAt;
    if (reverse === null) return null;
    const elapsed = occurredAt - riskTimeNanoseconds(reverse);
    if (elapsed <= 0n) throw new Error('Invalid R4 reverse timestamp');
    if (elapsed > BigInt(window) * MINUTE_NS) return null;
    // Rounded down, so the text never says more than the real elapsed time.
    const hundredths = (elapsed * 100n) / MINUTE_NS;
    const minutes = hundredths === 0n ? 'chưa đến 0,01' : `khoảng ${formatFixed2(hundredths)}`;
    return {
      id: this.id,
      weight: params.weight,
      explanation: `Tài khoản đích đã chuyển ngược lại ${minutes} phút trước.`,
    };
  }
}
