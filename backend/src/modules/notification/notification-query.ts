import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

export const DEFAULT_NOTIFICATION_LIMIT = 20;
export const MAX_NOTIFICATION_LIMIT = 50;

export const NOTIFICATION_FILTERS = ['all', 'in', 'out', 'account'] as const;
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];

/** The last item of the previous page: the two columns the list is ordered by. */
export interface NotificationCursor {
  readonly v: 1;
  /** `occurred_at`, UTC with exactly six fractional digits. */
  readonly t: string;
  /** `notification_log.id`, a positive bigint as a decimal string. */
  readonly id: string;
  /** The filter the cursor was issued for. */
  readonly f: NotificationFilter;
}

export interface ParsedNotificationQuery {
  readonly limit: number;
  readonly cursor: NotificationCursor | null;
  readonly filter: NotificationFilter;
}

/** One row of the page query, before the transfer behind it is looked up. */
export interface NotificationRow {
  id: string;
  kind: 'transfer_completed' | 'account_status_changed';
  message: string;
  occurredAt: string;
  read: boolean;
  transferId: string | null;
  accountId: string | null;
  counterpartyAccountId: string | null;
  direction: 'DEBIT' | 'CREDIT' | null;
}

const FIELDS = ['limit', 'cursor', 'filter'];
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

/** A positive bigint as a decimal string. */
function isNotificationId(value: string): boolean {
  return matches(/^[1-9]\d{0,18}$/, value) && BigInt(value) <= BIGINT_MAX;
}

/** A real calendar instant: PostgreSQL would answer 500 to `2026-02-30`. */
function isTimestamp(value: string): boolean {
  if (!matches(TIMESTAMP, value) || value < '1970') return false;
  const seconds = value.slice(0, 19);
  const parsed = new Date(`${seconds}Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === seconds;
}

function isFilter(value: unknown): value is NotificationFilter {
  return (NOTIFICATION_FILTERS as readonly unknown[]).includes(value);
}

function decodeCursor(value: string, filter: NotificationFilter): NotificationCursor {
  const message = 'cursor is invalid for this filter';
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
    Object.keys(parsed).length !== 4 ||
    !Object.keys(parsed).every(key => ['v', 't', 'id', 'f'].includes(key))
  ) {
    invalid(message);
  }
  const { v, t, id, f } = parsed;
  if (
    v !== 1 ||
    typeof t !== 'string' ||
    !isTimestamp(t) ||
    typeof id !== 'string' ||
    !isNotificationId(id) ||
    f !== filter
  ) {
    invalid(message);
  }
  return { v, t, id, f: filter };
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
  const filter = values.filter ?? 'all';
  if (!isFilter(filter)) invalid(`filter must be one of ${NOTIFICATION_FILTERS.join(', ')}`);
  return {
    limit: Number(limit),
    filter,
    cursor: values.cursor === undefined ? null : decodeCursor(values.cursor, filter),
  };
}

@Injectable()
export class NotificationQueryPipe implements PipeTransform<unknown, ParsedNotificationQuery> {
  transform(value: unknown): ParsedNotificationQuery {
    return parseNotificationQuery(value);
  }
}

export function encodeNotificationCursor(
  last: { id: string; occurredAt: string },
  filter: NotificationFilter,
): string {
  return Buffer.from(JSON.stringify({ v: 1, t: last.occurredAt, id: last.id, f: filter })).toString(
    'base64url',
  );
}

/** The body of `POST /v1/notifications/read`: exactly `{ upToId }`. */
export function parseMarkReadBody(raw: unknown): string {
  if (!record(raw) || Object.keys(raw).some(key => key !== 'upToId')) {
    invalid('body must be { upToId }');
  }
  const { upToId } = raw;
  if (typeof upToId !== 'string' || !isNotificationId(upToId)) {
    invalid('upToId must be a notification id');
  }
  return upToId;
}

@Injectable()
export class MarkReadPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    return parseMarkReadBody(value);
  }
}

export const UNREAD_COUNT_SQL = `SELECT count(*)::int AS count
FROM notification_log WHERE user_id = $1::uuid AND read_at IS NULL`;

/** Everything at or below the given notice in list order, and only the caller's rows. */
export const MARK_READ_SQL = `UPDATE notification_log n SET read_at = now()
FROM notification_log m
WHERE m.id = $2::bigint AND m.user_id = $1::uuid
  AND n.user_id = $1::uuid AND n.read_at IS NULL
  AND (n.occurred_at, n.id) <= (m.occurred_at, m.id)`;

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
  if (query.filter === 'in') predicates.push("n.direction = 'CREDIT'");
  if (query.filter === 'out') predicates.push("n.direction = 'DEBIT'");
  if (query.filter === 'account') predicates.push("n.kind = 'account_status_changed'");
  if (query.cursor !== null) {
    predicates.push(
      `(n.occurred_at, n.id) < (${parameter(query.cursor.t)}::timestamptz, ${parameter(query.cursor.id)}::bigint)`,
    );
  }
  const sql = `SELECT n.id::text AS id, n.kind, n.message,
  to_char(n.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
  n.read_at IS NOT NULL AS read, n.transfer_id AS "transferId", n.account_id AS "accountId",
  n.counterparty_account_id AS "counterpartyAccountId", n.direction
FROM notification_log n
WHERE ${predicates.join(' AND ')}
ORDER BY n.occurred_at DESC, n.id DESC
LIMIT ${parameter(query.limit + 1)}`;
  return { sql, parameters };
}
