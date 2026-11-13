import { MONEY_MAX, parsePositiveMoney } from '@common/money';
import {
  HISTORY_DAYS,
  MIN_HISTORY_FOR_MEDIAN,
  type Features,
  type TransferEvent,
} from '../features/feature-provider';
import { formatDong, formatDongHalf, formatTrimmed2 } from './explanation-format';
import type { RiskRule, RuleHit, RuleParams } from './rule';

/** The provider returns no median below five history rows, so a lower minimum cannot be honoured. */
const MIN_HISTORY_FLOOR = MIN_HISTORY_FOR_MEDIAN;
const MAX_WEIGHT = 2147483647;
const MAX_MULTIPLIER = 1000;
const MEDIAN_TIMES2_PATTERN = /^[1-9][0-9]*$/;
/** Whole-dong amounts are at most MONEY_MAX, so the doubled median is at most twice that. */
const MEDIAN_TIMES2_MAX = 2n * BigInt(MONEY_MAX);

function invalid(): never {
  // The message never repeats the offending value.
  throw new Error('Invalid R2 unusual-amount input or configuration');
}

/** The multiplier times 100 as an exact integer; at most two decimals, 0 < value <= 1000. */
function multiplierTimes100(value: unknown): bigint {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_MULTIPLIER
  ) {
    return invalid();
  }
  const scaled = Math.round(value * 100);
  if (scaled < 1 || Math.abs(value * 100 - scaled) > 1e-7) return invalid();
  return BigInt(scaled);
}

/**
 * Flags a transfer whose amount is more than `medianMultiplier` times the exact 30-day median of
 * the source account's earlier transfers. All arithmetic is bigint: `Features.medianAmount30dTimes2`
 * is twice the median (so an even history stays an integer), hence
 * `amount > multiplier * median` is `200 * amount > multiplier * 100 * medianTimes2`.
 */
export class R2UnusualAmountRule implements RiskRule {
  readonly id = 'R2' as const;

  evaluate(event: TransferEvent, features: Features, params: RuleParams): RuleHit | null {
    // A DEPOSIT is never scored, even if one slips through at runtime (same guard as R1).
    if ((event.type as string) !== 'TRANSFER') return null;

    const thresholds = params.thresholds as Record<string, unknown> | undefined;
    if (
      thresholds === undefined ||
      thresholds === null ||
      typeof params.enabled !== 'boolean' ||
      !Number.isInteger(params.weight) ||
      params.weight < 0 ||
      params.weight > MAX_WEIGHT ||
      thresholds.historyDays !== HISTORY_DAYS ||
      typeof thresholds.minHistory !== 'number' ||
      !Number.isSafeInteger(thresholds.minHistory) ||
      thresholds.minHistory < MIN_HISTORY_FLOOR
    ) {
      return invalid();
    }
    const m100 = multiplierTimes100(thresholds.medianMultiplier);

    if (!params.enabled) return null; // a switched-off rule judges only its configuration (BL-207(a))

    const amount = BigInt(parsePositiveMoney(event.amount));
    const count = features.historyCount30d;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return invalid();
    if (count < thresholds.minHistory) return null; // not enough history: skip, do not read the median

    const raw: unknown = features.medianAmount30dTimes2;
    if (typeof raw !== 'string' || raw.length > 20 || !MEDIAN_TIMES2_PATTERN.test(raw))
      return invalid();
    const medianTimes2 = BigInt(raw);
    if (medianTimes2 < 2n || medianTimes2 > MEDIAN_TIMES2_MAX) return invalid();

    const scaledAmount = 200n * amount;
    if (scaledAmount <= m100 * medianTimes2) return null;

    // amount / median, rounded down to two decimals (never overstates the multiple).
    const multiple100 = scaledAmount / medianTimes2;
    const multiple =
      multiple100 <= m100 ? `hơn ${formatTrimmed2(m100)}` : formatTrimmed2(multiple100);
    return {
      id: this.id,
      weight: params.weight,
      explanation: `Số tiền ${formatDong(amount)} gấp ${multiple}× trung vị 30 ngày (${formatDongHalf(medianTimes2)})`,
    };
  }
}
