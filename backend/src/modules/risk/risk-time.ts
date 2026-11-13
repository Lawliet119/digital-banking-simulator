import { isRealUtcTime } from '@common/events';

const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * Parse an event-contract timestamp without truncating its fractional seconds. Whether the string
 * is a real instant is the event schema's call (`isRealUtcTime`), not a second copy of the
 * calendar check; this regex only splits out the digits.
 */
export function riskTimeNanoseconds(value: unknown): bigint {
  if (typeof value !== 'string' || !isRealUtcTime(value)) throw new Error('Invalid risk timestamp');
  const match = UTC_TIME.exec(value);
  if (match === null) throw new Error('Invalid risk timestamp');
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const timestamp = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid risk timestamp');
  return BigInt(timestamp) * 1_000_000n + BigInt(fraction.padEnd(9, '0'));
}

/**
 * Epoch milliseconds of a risk timestamp, floored like SQL `date_trunc('milliseconds', ...)`.
 * BigInt division truncates toward zero, so a sub-millisecond instant before the epoch needs one more.
 */
export function riskTimeMilliseconds(value: unknown): number {
  const nanos = riskTimeNanoseconds(value);
  return Number(nanos / 1_000_000n - (nanos < 0n && nanos % 1_000_000n !== 0n ? 1n : 0n));
}
