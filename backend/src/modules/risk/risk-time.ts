const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/** Parse an event-contract timestamp without truncating its fractional seconds. */
export function riskTimeNanoseconds(value: unknown): bigint {
  if (typeof value !== 'string') throw new Error('Invalid risk timestamp');
  const match = UTC_TIME.exec(value);
  if (match === null) throw new Error('Invalid risk timestamp');
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const timestamp = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new Error('Invalid risk timestamp');
  }
  return BigInt(timestamp) * 1_000_000n + BigInt(fraction.padEnd(9, '0'));
}
