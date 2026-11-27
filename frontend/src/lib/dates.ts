const FORMAT = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  dateStyle: 'short',
  timeStyle: 'medium',
});

/** An API timestamp (UTC, ISO 8601) shown in Vietnam time. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : FORMAT.format(date);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The first instant of a calendar day in Vietnam (UTC+7, no daylight saving), as the UTC `Z`
 * string the history filter takes. `null` for anything that is not a real `YYYY-MM-DD`.
 */
export function vietnamDayStart(day: string): string | null {
  if (!DAY.test(day)) return null;
  const date = new Date(`${day}T00:00:00+07:00`);
  if (Number.isNaN(date.getTime())) return null;
  // `2026-02-30` rolls over to March: refuse it instead of filtering another day.
  const check = new Date(date.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  return check === day ? date.toISOString() : null;
}

/** The first instant of the day after `day` in Vietnam: an exclusive upper bound. */
export function vietnamDayEnd(day: string): string | null {
  const start = vietnamDayStart(day);
  return start === null ? null : new Date(Date.parse(start) + 86_400_000).toISOString();
}
