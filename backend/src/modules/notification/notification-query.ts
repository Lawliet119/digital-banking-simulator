import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

export const DEFAULT_NOTIFICATION_LIMIT = 20;
export const MAX_NOTIFICATION_LIMIT = 50;

/** The last item of the previous page: the two columns the list is ordered by. */
export interface NotificationCursor {
  readonly v: 1;
  /** `occurred_at`, UTC with exactly six fractional digits. */
  readonly t: string;
  /** `notification_log.id`, a positive bigint as a decimal string. */
  readonly id: string;
}

export interface ParsedNotificationQuery {
  readonly limit: number;
  readonly cursor: NotificationCursor | null;
}

const FIELDS = ['limit', 'cursor'];
const BIGINT_MAX = 9223372036854775807n;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function invalid(message: string): never {
  throw new BadRequestException({ errors: [message] });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matches(pattern: RegExp, value: string): boolean {
  // Compare the whole scalar so normalization cannot silently drop trailing data.
  return pattern.exec(value)?.[0] === value;
}

/** A real calendar instant: PostgreSQL would answer 500 to `2026-02-30`. */
function isTimestamp(value: string): boolean {
  if (!matches(TIMESTAMP, value) || value < '1970') return false;
  const seconds = value.slice(0, 19);
  const parsed = new Date(`${seconds}Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === seconds;
}

function decodeCursor(value: string): NotificationCursor {
  const message = 'cursor is invalid';
  if (value.length > 256 || !matches(/^[A-Za-z0-9_-]+$/, value)) invalid(message);
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.toString('base64url') !== value) invalid(message);
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    invalid(message);
  }
  if (
    !record(parsed) ||
    Object.keys(parsed).length !== 3 ||
    !Object.keys(parsed).every(key => ['v', 't', 'id'].includes(key))
  ) {
    invalid(message);
  }
  const { v, t, id } = parsed;
  if (
    v !== 1 ||
    typeof t !== 'string' ||
    !isTimestamp(t) ||
    typeof id !== 'string' ||
    !matches(/^[1-9]\d{0,18}$/, id) ||
    BigInt(id) > BIGINT_MAX
  ) {
    invalid(message);
  }
  return { v, t, id };
}

export function parseNotificationQuery(raw: unknown): ParsedNotificationQuery {
  if (!record(raw)) invalid('query must contain scalar parameters');
  if (Object.keys(raw).some(key => !FIELDS.includes(key))) invalid('unknown query parameter');
  const values: Partial<Record<string, string>> = {};
  for (const field of FIELDS) {
    if (!Object.hasOwn(raw, field)) continue;
    const value = raw[field];
    if (typeof value !== 'string') invalid('query parameters must be scalar strings');
    values[field] = value;
  }
  const limit = values.limit ?? String(DEFAULT_NOTIFICATION_LIMIT);
  if (!matches(/^(?:[1-9]|[1-4]\d|50)$/, limit)) {
    invalid(`limit must be an integer from 1 to ${MAX_NOTIFICATION_LIMIT}`);
  }
  return {
    limit: Number(limit),
    cursor: values.cursor === undefined ? null : decodeCursor(values.cursor),
  };
}

@Injectable()
export class NotificationQueryPipe implements PipeTransform<unknown, ParsedNotificationQuery> {
  transform(value: unknown): ParsedNotificationQuery {
    return parseNotificationQuery(value);
  }
}

export function encodeNotificationCursor(last: { id: string; occurredAt: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, t: last.occurredAt, id: last.id })).toString(
    'base64url',
  );
}

/**
 * Newest first by `occurred_at, id` (BL-211: delivery has no order, so `id` alone can show an
 * unlock before the lock it undoes). Columns are listed one by one: `event_id` and
 * `correlation_id` are not for the customer. Served by `notification_log_user_idx`.
 */
export function buildNotificationSql(
  userId: string,
  query: ParsedNotificationQuery,
): { sql: string; parameters: unknown[] } {
  const parameters: unknown[] = [];
  const parameter = (value: unknown): string => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  const predicates = [`n.user_id = ${parameter(userId)}::uuid`];
  if (query.cursor !== null) {
    predicates.push(
      `(n.occurred_at, n.id) < (${parameter(query.cursor.t)}::timestamptz, ${parameter(query.cursor.id)}::bigint)`,
    );
  }
  const sql = `SELECT n.id::text AS id, n.kind, n.message,
  to_char(n.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt"
FROM notification_log n
WHERE ${predicates.join(' AND ')}
ORDER BY n.occurred_at DESC, n.id DESC
LIMIT ${parameter(query.limit + 1)}`;
  return { sql, parameters };
}
