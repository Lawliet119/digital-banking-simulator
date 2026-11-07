import { parseBalance, parseMoney, parsePositiveMoney } from '@common/money';
import type { FeatureInput } from './ai-contract';

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
    const keys = Object.keys(record);
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
    if (
      typeof historyCount30d !== 'number' ||
      (historyCount30d === 0) !== (medianAmount30d === null)
    )
      throw new Error();
    if (medianAmount30d !== null) {
      if (typeof medianAmount30d !== 'string' || !/^(0|[1-9][0-9]*)(\.5)?$/.test(medianAmount30d))
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
