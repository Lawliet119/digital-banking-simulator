import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  buildSearchSql,
  escapeLike,
  fingerprintTerm,
  parseSearchQuery,
} from './operator-account-search.query';

const UUID = '2e859a80-d4d0-471d-8cee-e9d0de9d4bc7';
const rejects = (raw: unknown) => expect(() => parseSearchQuery(raw)).toThrow(BadRequestException);

describe('TC-88-11 operator account search term (no database)', () => {
  it('trims, normalizes to NFC and keeps 1 to 100 characters', () => {
    expect(parseSearchQuery({ q: '  Nguyễn  ' })).toEqual({ kind: 'name', term: 'Nguyễn' });
    const decomposed = 'Nguyễn'; // e + circumflex + tilde
    expect(parseSearchQuery({ q: decomposed })).toEqual({
      kind: 'name',
      term: decomposed.normalize('NFC'),
    });
    expect(parseSearchQuery({ q: 'a' }).term).toBe('a');
    expect(parseSearchQuery({ q: 'a'.repeat(100) }).term).toHaveLength(100);
    rejects({ q: 'a'.repeat(101) });
  });

  it('rejects a missing, empty or blank term and anything that is not one plain string', () => {
    rejects({});
    rejects({ q: '' });
    rejects({ q: '   ' });
    rejects({ q: ['a', 'b'] });
    rejects({ q: { $ne: 'x' } });
    rejects({ q: 'a', limit: '5' });
    rejects({ name: 'a' });
    rejects(null);
    rejects('q=a');
  });

  it('rejects control characters but allows Vietnamese letters and punctuation', () => {
    for (const bad of ['a\u0000b', 'a\nb', 'a\tb', 'a\u007fb', 'a\u0085b']) rejects({ q: bad });
    expect(parseSearchQuery({ q: "Đặng Thị Bích-Hạnh O'Neil" }).term).toBe(
      "Đặng Thị Bích-Hạnh O'Neil",
    );
  });

  it('tells a whole UUID (an account id) from a name, case-insensitively', () => {
    expect(parseSearchQuery({ q: UUID })).toEqual({ kind: 'id', term: UUID });
    expect(parseSearchQuery({ q: UUID.toUpperCase() })).toEqual({ kind: 'id', term: UUID });
    expect(parseSearchQuery({ q: ` ${UUID} ` }).kind).toBe('id');
    // Part of a UUID, or a UUID with something else, is a name search.
    expect(parseSearchQuery({ q: UUID.slice(0, 20) }).kind).toBe('name');
    expect(parseSearchQuery({ q: UUID + 'x' }).kind).toBe('name');
  });

  it('escapes the LIKE wildcards so the term is only ever literal text', () => {
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('%_\\')).toBe('\\%\\_\\\\');
    expect(escapeLike('Nguyễn')).toBe('Nguyễn');
  });

  it('builds a parameterized query: at most 20 rows, a stable order, no balance, no SYSTEM account', () => {
    const byName = buildSearchSql(parseSearchQuery({ q: '50%_' }));
    expect(byName.parameters).toEqual(['%50\\%\\_%']);
    expect(byName.sql).toContain("ILIKE $1 ESCAPE '\\'");
    expect(byName.sql).toContain('ORDER BY c.full_name, a.created_at, a.id');
    expect(byName.sql).toContain('LIMIT 20');
    expect(byName.sql).toContain('JOIN customers c ON c.id = a.customer_id');
    expect(byName.sql).not.toMatch(/balance|\*/i);
    expect(byName.sql).not.toContain('50');
    const byId = buildSearchSql(parseSearchQuery({ q: UUID }));
    expect(byId.parameters).toEqual([UUID]);
    expect(byId.sql).toContain('a.id = $1::uuid');
    expect(byId.sql).not.toMatch(/ILIKE/);
  });

  it('fingerprints a term with 32 hex characters of SHA-256 over the lower-case NFC term', () => {
    const expected = createHash('sha256').update('nguyễn').digest('hex').slice(0, 32);
    expect(fingerprintTerm('Nguyễn')).toBe(expected);
    expect(fingerprintTerm('NGUYỄN')).toBe(expected);
    expect(fingerprintTerm('Nguyễn')).toBe(expected);
    expect(fingerprintTerm('Trần')).not.toBe(expected);
    expect(fingerprintTerm('x')).toMatch(/^[0-9a-f]{32}$/);
  });
});
