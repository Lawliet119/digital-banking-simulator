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
 * BL-178: the name and the term are both folded as `lower(f_unaccent(x))`, in this order, so that
 * «nguyen» finds «Nguyễn» and the case of Vietnamese letters is not left to the server.
 * `unaccent` goes first on purpose: it turns Ư/ư, Ơ/ơ, Đ/đ and every toned vowel into plain ASCII,
 * and only then does `lower()` run, on ASCII, which every locale folds the same way. The old
 * `ILIKE` folded Ư/ư and Ơ/ơ through the locale of the server (it differs between the Alpine/musl
 * test image and RDS/glibc), so the same name could match on one and not on the other. Letters
 * outside Latin script (Cyrillic, Greek) are not touched by `unaccent`: for them `lower()` still
 * follows the server locale, which is acceptable because the customers are Vietnamese.
 *
 * `public.f_unaccent` is the IMMUTABLE wrapper of migration 1795000008000.
 */
const FOLDED_NAME = 'lower(public.f_unaccent(c.full_name))';
const FOLDED_TERM = 'lower(public.f_unaccent($1))';

/**
 * The term is a pattern that matches itself: `\`, `%` and `_` become text, never wildcards. The
 * escaping runs in SQL, AFTER the folding, and not in the application before it: `unaccent` turns
 * a full-width ％ (U+FF05), a small ﹪ (U+FE6A) and a full-width ＿ (U+FF3F) into `%` and `_`, and
 * an application-side escape would not have seen them. The backslash goes first, or the ones the
 * other two replacements add would be doubled. (The SQL literals are `'\'`, `'\\'`, `'\%'` and
 * `'\_'`: standard_conforming_strings is on from PostgreSQL 9.1, so a backslash is an ordinary
 * character in them.)
 */
const LITERAL_PATTERN = String.raw`'%' || replace(replace(replace(${FOLDED_TERM}, '\', '\\'), '%', '\%'), '_', '\_') || '%'`;

/**
 * Columns are listed one by one and there is no balance among them (FR-ACC-04). `JOIN customers`
 * leaves out the SYSTEM funding account, which has no owner. There is deliberately no index on
 * `customers.full_name` (database-design §6.2): about 50,000 rows, 20 results, a scan is enough. An
 * unanchored `LIKE '%…%'` could not use a b-tree anyway; if the table ever needs one, it is a
 * trigram index on `FOLDED_NAME`, which `f_unaccent` being IMMUTABLE makes possible (and which
 * serves `LIKE`, not `strpos`: that is why this stays a `LIKE`).
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
    sql:
      `${select}\nWHERE ${FOLDED_NAME} LIKE ${LITERAL_PATTERN} ESCAPE '\\'\n` +
      `ORDER BY c.full_name, a.created_at, a.id\nLIMIT ${MAX_SEARCH_RESULTS}`,
    parameters: [search.term],
  };
}
