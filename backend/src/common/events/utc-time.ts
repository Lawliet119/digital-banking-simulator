/**
 * ISO-8601 UTC with `Z`: seconds, and 1 to 9 fraction digits when there are any. An offset is
 * refused, `+00:00` included (producers use `Date#toISOString()`, never Postgres' `to_json`).
 */
const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

/**
 * Whether `value` is a real UTC instant in the event-contract format. The shape alone is not
 * enough: `Date.parse` rolls `2026-02-30` over to 2 March and accepts hour 24, so the calendar is
 * checked by hand. `setUTCFullYear` keeps years below 100 as written (`Date.UTC(99, …)` would mean
 * 1999).
 *
 * The single owner of this check: the event schema uses it for `occurredAt` and the account
 * snapshots, and a consumer that parses those strings again (the risk rules) asks it too, instead
 * of keeping a private copy that could drift.
 */
export function isRealUtcTime(value: string): boolean {
  const match = UTC_TIME.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const lastDayOfMonth = new Date(0);
  lastDayOfMonth.setUTCFullYear(year, month, 0);
  return day >= 1 && day <= lastDayOfMonth.getUTCDate();
}
