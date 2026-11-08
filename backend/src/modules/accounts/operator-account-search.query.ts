import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

/** How a lookup is asked: by the whole account id, or by part of the owner's name. */
export interface ParsedSearch {
  readonly kind: 'id' | 'name';
  /** NFC, trimmed; an `id` term is lower-case. */
  readonly term: string;
}

export const MAX_SEARCH_RESULTS = 20;
export const MAX_TERM_LENGTH = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(message: string): never {
  throw new BadRequestException({ errors: [message] });
}

export function parseSearchQuery(raw: unknown): ParsedSearch {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalid('query must contain scalar parameters');
  }
  const query = raw as Record<string, unknown>;
  if (Object.keys(query).some(key => key !== 'q')) invalid('unknown query parameter');
  if (typeof query.q !== 'string') invalid('q is required and must be one string');
  const term = query.q.normalize('NFC').trim();
  if (term.length < 1 || [...term].length > MAX_TERM_LENGTH) {
    invalid(`q must contain 1 to ${MAX_TERM_LENGTH} characters`);
  }
  if (/\p{Cc}/u.test(term)) invalid('q must not contain control characters');
  return UUID.test(term) ? { kind: 'id', term: term.toLowerCase() } : { kind: 'name', term };
}

@Injectable()
export class SearchQueryPipe implements PipeTransform<unknown, ParsedSearch> {
  transform(value: unknown): ParsedSearch {
    return parseSearchQuery(value);
  }
}

/** `%`, `_` and the escape character itself are text, never wildcards. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

/**
 * What the audit log keeps of a name search: 32 hex characters of SHA-256 over the lower-case NFC
 * term. The log never holds the name (PII); an auditor who knows a name can hash it and look.
 */
export function fingerprintTerm(term: string): string {
  return createHash('sha256')
    .update(term.normalize('NFC').toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

/**
 * Columns are listed one by one and there is no balance among them (FR-ACC-04). `JOIN customers`
 * leaves out the SYSTEM funding account, which has no owner. There is deliberately no index on
 * `customers.full_name` (database-design §6.2): about 50,000 rows, 20 results, a scan is enough.
 */
export function buildSearchSql(search: ParsedSearch): { sql: string; parameters: unknown[] } {
  const select = `SELECT a.id, a.type, a.status, c.full_name AS "ownerName"
FROM accounts a JOIN customers c ON c.id = a.customer_id`;
  if (search.kind === 'id') {
    return {
      sql: `${select}\nWHERE a.id = $1::uuid\nLIMIT ${MAX_SEARCH_RESULTS}`,
      parameters: [search.term],
    };
  }
  return {
    sql: `${select}
WHERE c.full_name ILIKE $1 ESCAPE '\\'
ORDER BY c.full_name, a.created_at, a.id
LIMIT ${MAX_SEARCH_RESULTS}`,
    parameters: [`%${escapeLike(search.term)}%`],
  };
}
