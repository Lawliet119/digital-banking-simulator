import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { AuditOutcome } from './audit.types';

export interface AuditSearchFilters {
  readonly actorUserId: string | null;
  readonly action: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly correlationId: string | null;
}

export interface AuditSearchCursor {
  readonly v: 1;
  readonly t: string;
  readonly id: string;
  readonly f: string;
}

export interface ParsedAuditSearchQuery extends AuditSearchFilters {
  readonly limit: number;
  readonly cursor: AuditSearchCursor | null;
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorRole: string;
  action: string;
  outcome: AuditOutcome;
  target: { type: string; id: string };
  correlationId: string;
  metadata: Record<string, unknown>;
}

export interface AuditEntriesPage {
  entries: AuditEntry[];
  nextCursor: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = ['actorUserId', 'action', 'from', 'to', 'correlationId', 'limit', 'cursor'];
const BIGINT_MAX = 9223372036854775807n;

function invalid(message: string): never {
  throw new BadRequestException({ errors: [message] });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matches(pattern: RegExp, value: string): boolean {
  // Compare the complete scalar so normalization cannot silently discard trailing data.
  return pattern.exec(value)?.[0] === value;
}

function uuid(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  if (value.length !== 36 || !UUID.test(value)) invalid(`${field} must be a UUID`);
  return value.toLowerCase();
}

function timestamp(value: string): string | null {
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

function fingerprint(filters: AuditSearchFilters): string {
  // Fixed order and nulls make an equivalent normalized query reuse its cursor. Limit is not a filter.
  return createHash('sha256')
    .update(
      JSON.stringify({
        actorUserId: filters.actorUserId,
        action: filters.action,
        from: filters.from,
        to: filters.to,
        correlationId: filters.correlationId,
      }),
    )
    .digest('hex');
}

function decodeCursor(value: string, filters: AuditSearchFilters): AuditSearchCursor {
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
  )
    invalid(message);
  const { v, t, id, f } = parsed;
  if (
    v !== 1 ||
    typeof t !== 'string' ||
    timestamp(t) !== t ||
    typeof id !== 'string' ||
    !matches(/^[1-9]\d{0,18}$/, id) ||
    BigInt(id) > BIGINT_MAX ||
    typeof f !== 'string' ||
    !matches(/^[0-9a-f]{64}$/, f) ||
    f !== fingerprint(filters)
  ) {
    invalid(message);
  }
  return { v, t, id, f };
}

export function parseAuditSearchQuery(raw: unknown): ParsedAuditSearchQuery {
  if (!record(raw)) invalid('audit search query must contain scalar parameters');
  if (Object.keys(raw).some(key => !FIELDS.includes(key)))
    invalid('unknown audit search query parameter');
  const values: Partial<Record<(typeof FIELDS)[number], string>> = {};
  for (const field of FIELDS) {
    if (Object.hasOwn(raw, field)) {
      const value = raw[field];
      if (typeof value !== 'string')
        invalid('audit search query parameters must be scalar strings');
      values[field] = value;
    }
  }
  const action = values.action ?? null;
  if (
    action !== null &&
    (action.length < 1 ||
      action.length > 128 ||
      action.trim().length === 0 ||
      /\p{Cc}/u.test(action))
  ) {
    invalid('action must contain 1 to 128 characters without control characters');
  }
  const from = values.from === undefined ? null : timestamp(values.from);
  const to = values.to === undefined ? null : timestamp(values.to);
  if (values.from !== undefined && from === null) invalid('from must be a valid UTC timestamp');
  if (values.to !== undefined && to === null) invalid('to must be a valid UTC timestamp');
  if (from !== null && to !== null && from >= to) invalid('from must precede to');
  const filters: AuditSearchFilters = {
    actorUserId: uuid(values.actorUserId, 'actorUserId'),
    action,
    from,
    to,
    correlationId: uuid(values.correlationId, 'correlationId'),
  };
  const limit = values.limit ?? '50';
  if (!matches(/^(?:[1-9]\d?|100)$/, limit)) invalid('limit must be an integer from 1 to 100');
  return {
    ...filters,
    limit: Number(limit),
    cursor: values.cursor === undefined ? null : decodeCursor(values.cursor, filters),
  };
}

@Injectable()
export class AuditSearchQueryPipe implements PipeTransform<unknown, ParsedAuditSearchQuery> {
  transform(value: unknown): ParsedAuditSearchQuery {
    return parseAuditSearchQuery(value);
  }
}

export function encodeAuditSearchCursor(
  last: Pick<AuditEntry, 'id' | 'occurredAt'>,
  filters: AuditSearchFilters,
): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: last.occurredAt, id: last.id, f: fingerprint(filters) }),
  ).toString('base64url');
}

export function buildAuditSearchSql(query: ParsedAuditSearchQuery): {
  sql: string;
  parameters: unknown[];
} {
  const parameters: unknown[] = [];
  const predicates: string[] = [];
  const parameter = (value: unknown): string => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  if (query.actorUserId !== null)
    predicates.push(`a.actor_user_id = ${parameter(query.actorUserId)}::uuid`);
  if (query.action !== null) predicates.push(`a.action = ${parameter(query.action)}`);
  if (query.from !== null)
    predicates.push(`a.occurred_at >= ${parameter(query.from)}::timestamptz`);
  if (query.to !== null) predicates.push(`a.occurred_at < ${parameter(query.to)}::timestamptz`);
  if (query.correlationId !== null)
    predicates.push(`a.correlation_id = ${parameter(query.correlationId)}::uuid`);
  if (query.cursor !== null) {
    predicates.push(
      `(a.occurred_at, a.id) < (${parameter(query.cursor.t)}::timestamptz, ${parameter(query.cursor.id)}::bigint)`,
    );
  }
  const sql = `SELECT a.id::text AS id,
  to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
  a.actor_user_id AS "actorUserId", a.actor_role AS "actorRole", a.action, a.outcome,
  a.target_type AS "targetType", a.target_id AS "targetId", a.correlation_id AS "correlationId", a.metadata
FROM audit_log a${predicates.length === 0 ? '' : `\nWHERE ${predicates.join(' AND ')}`}
ORDER BY a.occurred_at DESC, a.id DESC
LIMIT ${parameter(query.limit + 1)}`;
  return { sql, parameters };
}
