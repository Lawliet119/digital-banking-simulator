import type { Features, TransferEvent } from '../features/feature-provider';
import type { RiskRule, RuleHit, RuleParams } from './rule';

/** Flag distinct new recipients within the provider's one-hour window. */
export class R5FanOutRule implements RiskRule {
  readonly id = 'R5' as const;

  evaluate(event: TransferEvent, features: Features, params: RuleParams): RuleHit | null {
    if ((event.type as string) !== 'TRANSFER') return null;
    const minimum = params.thresholds?.minNewRecipients;
    if (
      typeof params.enabled !== 'boolean' ||
      !Number.isInteger(params.weight) ||
      params.weight < 0 ||
      params.weight > 2_147_483_647 ||
      typeof minimum !== 'number' ||
      !Number.isSafeInteger(minimum) ||
      minimum < 1 ||
      params.thresholds?.windowMinutes !== 60 ||
      params.thresholds?.noveltyDays !== 30
    )
      throw new Error('Invalid R5 configuration');
    if (!params.enabled) return null; // a switched-off rule judges only its configuration (BL-207(a))
    if (typeof event.sameOwner !== 'boolean') throw new Error('Invalid R5 owner snapshot');
    const count = features.newRecipients1h;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid R5 recipient count');
    if (event.sameOwner || count < minimum) return null;
    return {
      id: this.id,
      weight: params.weight,
      explanation: `${count} người nhận mới trong 1 giờ (ngưỡng ${minimum}).`,
    };
  }
}
