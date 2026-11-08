import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

/** Filters that a cursor is bound to. `limit` is not a filter: a client may change page size. */
export interface HistoryFilters {
  readonly from: string | null;
  readonly to: string | null;
}

export interface HistoryCursor {
  readonly v: 1;
  /** `created_at` of the last line of the previous page, UTC, exactly six fractional digits. */
  readonly t: string;
  /** `ledger_entries.id` of that line, a positive bigint as a decimal string. */
  readonly id: string;
  /** Fingerprint of the filters, so a cursor cannot be replayed against another filter. */
  readonly f: string;
}

export interface ParsedHistoryQuery extends HistoryFilters {
  readonly limit: number;
  readonly cursor: HistoryCursor | null;
}

export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 100;

const FIELDS = ['limit', 'cursor', 'from', 'to'];
const BIGINT_MAX = 9223372036854775807n;

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

/** `2026-03-15T09:30:00Z` or with 1 to 6 fractional digits; returns it with exactly six, or null. */
export function normalizeTimestamp(value: string): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!parts || parts[0] !== value) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  if (year < 1970 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]) return null;
  return `${value.slice(0, 19)}.${(parts[7] ?? '').padEnd(6, '0')}Z`;
}

function fingerprint(filters: HistoryFilters): string {
  return createHash('sha256')
    .update(JSON.stringify({ from: filters.from, to: filters.to }))
    .digest('hex');
}

function decodeCursor(value: string, filters: HistoryFilters): HistoryCursor {
  const message = 'cursor is invalid for these filters';
  if (value.length > 512 || !matches(/^[A-Za-z0-9_-]+$/, value)) invalid(message);
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
    normalizeTimestamp(t) !== t ||
    typeof id !== 'string' ||
    !matches(/^[1-9]\d{0,18}$/, id) ||
    BigInt(id) > BIGINT_MAX ||
    typeof f !== 'string' ||
    f !== fingerprint(filters)
  ) {
    invalid(message);
  }
  return { v, t, id, f };
}

export function parseHistoryQuery(raw: unknown): ParsedHistoryQuery {
  if (!record(raw)) invalid('query must contain scalar parameters');
  if (Object.keys(raw).some(key => !FIELDS.includes(key))) invalid('unknown query parameter');
  const values: Partial<Record<string, string>> = {};
  for (const field of FIELDS) {
    if (!Object.hasOwn(raw, field)) continue;
    const value = raw[field];
    if (typeof value !== 'string') invalid('query parameters must be scalar strings');
    values[field] = value;
  }
  const from = values.from === undefined ? null : normalizeTimestamp(values.from);
  const to = values.to === undefined ? null : normalizeTimestamp(values.to);
  if (values.from !== undefined && from === null) invalid('from must be a valid UTC timestamp');
  if (values.to !== undefined && to === null) invalid('to must be a valid UTC timestamp');
  if (from !== null && to !== null && from >= to) invalid('from must precede to');
  const filters: HistoryFilters = { from, to };
  const limit = values.limit ?? String(DEFAULT_HISTORY_LIMIT);
  if (!matches(/^(?:[1-9]\d?|100)$/, limit)) {
    invalid(`limit must be an integer from 1 to ${MAX_HISTORY_LIMIT}`);
  }
  return {
    ...filters,
    limit: Number(limit),
    cursor: values.cursor === undefined ? null : decodeCursor(values.cursor, filters),
  };
}

@Injectable()
export class HistoryQueryPipe implements PipeTransform<unknown, ParsedHistoryQuery> {
  transform(value: unknown): ParsedHistoryQuery {
    return parseHistoryQuery(value);
  }
}

export function encodeHistoryCursor(
  last: { entryId: string; createdAt: string },
  filters: HistoryFilters,
): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: last.createdAt, id: last.entryId, f: fingerprint(filters) }),
  ).toString('base64url');
}

/**
 * The page query. Columns are listed one by one on purpose: a `SELECT *` would hand any column
 * added to `transfers` or `ledger_entries` later (a fraud flag, a score) to the customer.
 * `ORDER BY created_at DESC, id DESC` is the order of `ledger_entries_account_history_idx`, so
 * page one is an Index Scan without a Sort, and the keyset condition is a row comparison
 * on the same two columns. There is no OFFSET.
 */
export function buildHistorySql(
  accountId: string,
  query: ParsedHistoryQuery,
): { sql: string; parameters: unknown[] } {
  const parameters: unknown[] = [];
  const parameter = (value: unknown): string => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  const predicates = [`e.account_id = ${parameter(accountId)}::uuid`];
  if (query.from !== null) predicates.push(`e.created_at >= ${parameter(query.from)}::timestamptz`);
  if (query.to !== null) predicates.push(`e.created_at < ${parameter(query.to)}::timestamptz`);
  if (query.cursor !== null) {
    predicates.push(
      `(e.created_at, e.id) < (${parameter(query.cursor.t)}::timestamptz, ${parameter(query.cursor.id)}::bigint)`,
    );
  }
  const sql = `SELECT e.id::text AS "entryId", e.transfer_id AS "transferId", t.type,
  e.direction, e.amount::text AS amount, e.balance_after::text AS "balanceAfter",
  CASE WHEN t.type = 'DEPOSIT' THEN NULL
       WHEN e.direction = 'DEBIT' THEN t.to_account_id
       ELSE t.from_account_id END AS "counterpartyAccountId",
  to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
FROM ledger_entries e JOIN transfers t ON t.id = e.transfer_id
WHERE ${predicates.join(' AND ')}
ORDER BY e.created_at DESC, e.id DESC
LIMIT ${parameter(query.limit + 1)}`;
  return { sql, parameters };
}
