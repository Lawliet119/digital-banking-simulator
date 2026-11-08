import { parseBalance, parsePositiveMoney } from '@common/money';
import type { Features, TransferEvent } from '../features/feature-provider';
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
    if (typeof event.sameOwner !== 'boolean') throw new Error('Invalid R6 owner snapshot');
    const balance = parseBalance(event.fromBalanceBefore);
    const amount = parsePositiveMoney(event.amount);
    if (
      !params.enabled ||
      event.sameOwner ||
      balance < minBalance ||
      amount * 100n < balance * BigInt(percent)
    ) {
      return null;
    }
    const hundredths = (amount * 10_000n + balance / 2n) / balance;
    const display = `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
    return {
      id: this.id,
      weight: params.weight,
      explanation: `Chuyển xấp xỉ ${display}% số dư (${amount}/${balance}đ).`,
    };
  }
}
