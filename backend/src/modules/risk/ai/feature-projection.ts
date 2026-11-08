import { MONEY_MAX, parseBalance, parseMoney, parsePositiveMoney } from '@common/money';
import type { Features, TransferEvent } from '../features/feature-provider';
import { riskTimeNanoseconds } from '../risk-time';
import type { FeatureInput } from './ai-contract';

const MIN_HISTORY_FOR_MEDIAN = 5;
const MAX_ACCOUNT_AGE_HOURS = 720;
const HOUR_NS = 3_600_000_000_000n;
const MINUTE_NS = 60_000_000_000n;

const KEYS: readonly (keyof FeatureInput)[] = [
  'amount',
  'fromBalanceBefore',
  'accountAgeHours',
  'sameOwner',
  'txCount10m',
  'txCount1h',
  'historyCount30d',
  'medianAmount30d',
  'minutesSinceReverse',
  'newRecipients1h',
  'distinctRecipients24h',
];

/** Reject unexpected fields before constructing the provider payload. */
export function projectFeatures(input: unknown): FeatureInput {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error();
    const record = input as Record<string, unknown>;
    const keys = Reflect.ownKeys(record);
    if (keys.length !== KEYS.length || KEYS.some(key => !Object.hasOwn(record, key)))
      throw new Error();
    const {
      amount,
      fromBalanceBefore,
      accountAgeHours,
      sameOwner,
      txCount10m,
      txCount1h,
      historyCount30d,
      medianAmount30d,
      minutesSinceReverse,
      newRecipients1h,
      distinctRecipients24h,
    } = record;
    if (typeof amount !== 'string' || typeof fromBalanceBefore !== 'string') throw new Error();
    parsePositiveMoney(amount);
    parseBalance(fromBalanceBefore);
    if (
      typeof sameOwner !== 'boolean' ||
      typeof accountAgeHours !== 'number' ||
      !Number.isFinite(accountAgeHours) ||
      accountAgeHours < 0
    )
      throw new Error();
    if (
      minutesSinceReverse !== null &&
      (typeof minutesSinceReverse !== 'number' ||
        !Number.isFinite(minutesSinceReverse) ||
        minutesSinceReverse < 0)
    )
      throw new Error();
    const counts = [txCount10m, txCount1h, historyCount30d, newRecipients1h, distinctRecipients24h];
    if (
      counts.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    )
      throw new Error();
    if (typeof historyCount30d !== 'number') throw new Error();
    // 0 history rows must have null median; >= 5 rows must have a median; 1..4 rows allow null
    // (matching FeatureProvider, where R2 requires at least 5 historical transfers).
    if (historyCount30d === 0 && medianAmount30d !== null) throw new Error();
    if (historyCount30d >= MIN_HISTORY_FOR_MEDIAN && medianAmount30d === null) throw new Error();
    if (medianAmount30d !== null) {
      if (
        typeof medianAmount30d !== 'string' ||
        !/^(0|[1-9][0-9]*)(\.5)?$/.test(medianAmount30d) ||
        medianAmount30d === '0' ||
        medianAmount30d === '0.5'
      )
        throw new Error();
      const [whole] = medianAmount30d.split('.');
      const parsed = parseMoney(whole);
      if (parsed === 9223372036854775807n && medianAmount30d.endsWith('.5')) throw new Error();
    }
    return {
      amount,
      fromBalanceBefore,
      accountAgeHours,
      sameOwner,
      txCount10m: txCount10m as number,
      txCount1h: txCount1h as number,
      historyCount30d,
      medianAmount30d,
      minutesSinceReverse,
      newRecipients1h: newRecipients1h as number,
      distinctRecipients24h: distinctRecipients24h as number,
    };
  } catch {
    throw new Error('Invalid AI features');
  }
}

/**
 * Projects a `TransferEvent` and point-in-time `Features` from `FeatureProvider` into the
 * allowlisted `FeatureInput` shape expected by the external AI adapter.
 */
export function toAiFeatureInput(event: TransferEvent, features: Features): FeatureInput {
  try {
    const occurredAt = event.occurredAt;
    const createdAt = event.fromAccountCreatedAt;
    const occurredNs = riskTimeNanoseconds(occurredAt);
    const createdNs = riskTimeNanoseconds(createdAt);
    const ageNs = occurredNs - createdNs;
    const accountAgeHours =
      ageNs <= 0n
        ? 0
        : ageNs >= BigInt(MAX_ACCOUNT_AGE_HOURS) * HOUR_NS
          ? MAX_ACCOUNT_AGE_HOURS
          : Number(ageNs) / Number(HOUR_NS);

    let medianAmount30d: string | null = null;
    const raw = features.medianAmount30dTimes2;
    if (raw !== null) {
      if (typeof raw !== 'string' || raw.length > 20 || !/^[1-9][0-9]*$/.test(raw)) {
        throw new Error();
      }
      const twice = BigInt(raw);
      if (twice < 2n || twice > 2n * MONEY_MAX) throw new Error();
      const half = twice / 2n;
      medianAmount30d = twice % 2n === 0n ? half.toString() : `${half.toString()}.5`;
    }

    let minutesSinceReverse: number | null = null;
    const reverseAt = features.reverseTransferOccurredAt;
    if (reverseAt !== null) {
      const elapsed = occurredNs - riskTimeNanoseconds(reverseAt);
      if (elapsed <= 0n) throw new Error();
      minutesSinceReverse = Number(elapsed) / Number(MINUTE_NS);
    }

    return projectFeatures({
      amount: event.amount,
      fromBalanceBefore: event.fromBalanceBefore,
      accountAgeHours,
      sameOwner: event.sameOwner,
      txCount10m: features.txCount10m,
      txCount1h: features.txCount1h,
      historyCount30d: features.historyCount30d,
      medianAmount30d,
      minutesSinceReverse,
      newRecipients1h: features.newRecipients1h,
      distinctRecipients24h: features.distinctRecipients24h,
    });
  } catch {
    throw new Error('Invalid AI features');
  }
}
