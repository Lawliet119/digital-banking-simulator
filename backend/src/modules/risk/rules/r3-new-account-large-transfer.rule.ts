import { parseMoney, parsePositiveMoney } from '@common/money';
import type { Features, TransferEvent } from '../features/feature-provider';
import type { RiskRule, RuleHit, RuleParams } from './rule';

const MAX_WEIGHT = 2147483647;
const MAX_AGE_HOURS_LIMIT = 87600; // ten years: anything larger is a configuration mistake
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** ISO-8601 UTC with `Z`, seconds, 1 to 9 fraction digits when present (the event contract). */
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function invalidConfig(): never {
  // The messages never repeat the offending value.
  throw new Error('Invalid R3 configuration');
}

function invalidField(field: string): never {
  throw new Error(`Invalid R3 snapshot field: ${field}`);
}

/**
 * The instant of a real UTC timestamp, in milliseconds (sub-millisecond digits are dropped; the
 * producer uses `Date#toISOString()`, so there are none in practice). `Date.parse` alone rolls
 * `2026-02-30` over and accepts hour 24, so the result must print back to the same date and time.
 */
function utcInstant(value: unknown, field: string): number {
  if (typeof value !== 'string' || !UTC_TIME.test(value)) return invalidField(field);
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    return invalidField(field);
  }
  return ms;
}

/** Whole-dong amount with dot-grouped thousands, as in the guide's sample (`20.000.000đ`). */
function formatDong(amount: bigint): string {
  // On the digit string only: `Number` and `toLocaleString` lose digits above 2^53.
  return `${amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
}

/** The age rounded down, so the text never says more than the real age. */
function formatAge(ageMs: number): string {
  if (ageMs < MINUTE_MS) return 'dưới 1 phút';
  if (ageMs < HOUR_MS) return `${Math.floor(ageMs / MINUTE_MS)} phút`;
  return `${Math.floor(ageMs / HOUR_MS)} giờ`;
}

/**
 * Flags a transfer from an account younger than `maxAccountAgeHoursExclusive` that moves more than
 * `minAmountExclusive`. It reads only the event snapshot (`occurredAt`, `fromAccountCreatedAt`,
 * `amount`), never the database. A snapshot created after the transfer (a clock stepped back) is
 * age 0: the account is at least that new, and a thrown error would silently skip the rule.
 */
export class R3NewAccountLargeTransferRule implements RiskRule {
  readonly id = 'R3' as const;

  evaluate(event: TransferEvent, _features: Features, params: RuleParams): RuleHit | null {
    // A DEPOSIT is never scored, even if one slips through at runtime (same guard as R1, R2).
    if ((event.type as string) !== 'TRANSFER') return null;

    const thresholds = params.thresholds as Record<string, unknown> | undefined | null;
    if (
      thresholds === undefined ||
      thresholds === null ||
      typeof params.enabled !== 'boolean' ||
      !Number.isInteger(params.weight) ||
      params.weight < 0 ||
      params.weight > MAX_WEIGHT
    ) {
      return invalidConfig();
    }
    const maxAgeHours = thresholds.maxAccountAgeHoursExclusive;
    if (
      typeof maxAgeHours !== 'number' ||
      !Number.isSafeInteger(maxAgeHours) ||
      maxAgeHours < 1 ||
      maxAgeHours > MAX_AGE_HOURS_LIMIT ||
      typeof thresholds.minAmountExclusive !== 'string'
    ) {
      return invalidConfig();
    }
    let minAmount: bigint;
    try {
      minAmount = BigInt(parseMoney(thresholds.minAmountExclusive));
    } catch {
      return invalidConfig();
    }

    if (!params.enabled) return null; // a switched-off rule does not judge the data

    let amount: bigint;
    try {
      amount = BigInt(parsePositiveMoney(event.amount));
    } catch {
      return invalidField('amount');
    }
    const occurredAt = utcInstant(event.occurredAt, 'occurredAt');
    const createdAt = utcInstant(event.fromAccountCreatedAt, 'fromAccountCreatedAt');
    const ageMs = Math.max(0, occurredAt - createdAt);

    if (ageMs >= maxAgeHours * HOUR_MS || amount <= minAmount) return null;
    return {
      id: this.id,
      weight: params.weight,
      explanation: `Tài khoản mở ${formatAge(ageMs)} trước, chuyển ${formatDong(amount)}`,
    };
  }
}
