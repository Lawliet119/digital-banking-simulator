import { parseBalance, parsePositiveMoney } from '@common/money';
import type { Features, TransferEvent } from '../features/feature-provider';
import { formatDong, formatFixed2 } from './explanation-format';
import type { RiskRule, RuleHit, RuleParams } from './rule';

/** Detect a high fraction of the balance snapshot, without floating-point money. */
export class R6DrainRule implements RiskRule {
  readonly id = 'R6' as const;

  evaluate(event: TransferEvent, _features: Features, params: RuleParams): RuleHit | null {
    if ((event.type as string) !== 'TRANSFER') return null;
    const percent = params.thresholds?.minBalancePercent;
    const minimum = params.thresholds?.minBalance;
    if (
      typeof params.enabled !== 'boolean' ||
      !Number.isInteger(params.weight) ||
      params.weight < 0 ||
      params.weight > 2_147_483_647 ||
      typeof percent !== 'number' ||
      !Number.isInteger(percent) ||
      percent < 1 ||
      percent > 100 ||
      typeof minimum !== 'string'
    )
      throw new Error('Invalid R6 configuration');
    const minBalance = parsePositiveMoney(minimum);
    if (!params.enabled) return null; // a switched-off rule judges only its configuration (BL-207(a))
    if (typeof event.sameOwner !== 'boolean') throw new Error('Invalid R6 owner snapshot');
    const balance = parseBalance(event.fromBalanceBefore);
    const amount = parsePositiveMoney(event.amount);
    if (event.sameOwner || balance < minBalance || amount * 100n < balance * BigInt(percent)) {
      return null;
    }
    // Rounded down (BL-207(d)): 99,996 % must not read as a complete drain.
    const hundredths = (amount * 10_000n) / balance;
    return {
      id: this.id,
      weight: params.weight,
      explanation: `Chuyển xấp xỉ ${formatFixed2(hundredths)}% số dư (${formatDong(amount)}/${formatDong(balance)}).`,
    };
  }
}
