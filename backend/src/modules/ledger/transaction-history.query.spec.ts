import { BadRequestException } from '@nestjs/common';
import {
  buildHistorySql,
  encodeHistoryCursor,
  normalizeTimestamp,
  parseHistoryQuery,
} from './transaction-history.query';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const NO_FILTER: { from: string | null; to: string | null } = { from: null, to: null };
const cursorOf = (over: object, filters = NO_FILTER) =>
  encodeHistoryCursor(
    { entryId: '42', createdAt: '2026-03-15T02:30:00.123456Z', ...over },
    filters,
  );
const rejects = (raw: unknown) => expect(() => parseHistoryQuery(raw)).toThrow(BadRequestException);

describe('TC-87-12 transaction history query (no database)', () => {
  it('defaults to 20 rows, accepts 1..100, rejects everything else', () => {
    expect(parseHistoryQuery({}).limit).toBe(20);
    expect(parseHistoryQuery({ limit: '1' }).limit).toBe(1);
    expect(parseHistoryQuery({ limit: '100' }).limit).toBe(100);
    for (const limit of ['0', '101', '-1', '1.5', '1e1', ' 5', '05', 'abc', '']) rejects({ limit });
  });

  it('rejects unknown, repeated and non-scalar parameters', () => {
    rejects({ offset: '20' });
    rejects({ limit: ['1', '2'] });
    rejects({ from: { $gt: 'x' } });
    rejects(null);
    rejects('limit=5');
  });

  it('keeps six fractional digits of a UTC timestamp and rejects anything else', () => {
    expect(normalizeTimestamp('2026-03-15T09:30:00Z')).toBe('2026-03-15T09:30:00.000000Z');
    expect(normalizeTimestamp('2026-03-15T09:30:00.12Z')).toBe('2026-03-15T09:30:00.120000Z');
    expect(normalizeTimestamp('2026-03-15T09:30:00.123456Z')).toBe('2026-03-15T09:30:00.123456Z');
    for (const bad of [
      '2026-03-15T09:30:00',
      '2026-03-15T09:30:00+07:00',
      '2026-03-15 09:30:00Z',
      '2026-02-30T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-03-15T24:00:00Z',
      '2026-03-15T09:30:00.1234567Z',
      '1969-12-31T23:59:59Z',
      '2026-03-15T09:30:00Z ',
    ])
      expect(normalizeTimestamp(bad)).toBeNull();
    expect(normalizeTimestamp('2028-02-29T00:00:00Z')).not.toBeNull(); // leap day
  });

  it('requires from < to', () => {
    expect(
      parseHistoryQuery({ from: '2026-03-14T17:00:00Z', to: '2026-03-15T17:00:00Z' }),
    ).toMatchObject({
      from: '2026-03-14T17:00:00.000000Z',
      to: '2026-03-15T17:00:00.000000Z',
    });
    rejects({ from: '2026-03-15T17:00:00Z', to: '2026-03-15T17:00:00Z' });
    rejects({ from: '2026-03-16T00:00:00Z', to: '2026-03-15T00:00:00Z' });
  });

  it('round-trips a cursor keeping the microseconds, and a cursor is bound to its filters', () => {
    const parsed = parseHistoryQuery({ cursor: cursorOf({}) });
    expect(parsed.cursor).toMatchObject({ v: 1, t: '2026-03-15T02:30:00.123456Z', id: '42' });
    const filters = { from: '2026-03-14T17:00:00.000000Z', to: null };
    const bound = cursorOf({}, filters);
    expect(parseHistoryQuery({ from: '2026-03-14T17:00:00Z', cursor: bound }).cursor?.id).toBe(
      '42',
    );
    rejects({ cursor: bound }); // no filter
    rejects({ from: '2026-03-14T18:00:00Z', cursor: bound }); // another filter
    rejects({ to: '2026-03-14T18:00:00Z', cursor: bound });
  });

  it('rejects damaged cursors', () => {
    const good = cursorOf({});
    const reencode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = JSON.parse(Buffer.from(good, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    for (const cursor of [
      '',
      'not base64 !',
      good + '=',
      good.slice(0, -2),
      'a'.repeat(513),
      reencode({ ...body, v: 2 }),
      reencode({ ...body, id: '0' }),
      reencode({ ...body, id: '9223372036854775808' }),
      reencode({ ...body, id: '1; DROP TABLE ledger_entries' }),
      reencode({ ...body, t: '2026-03-15T02:30:00Z' }),
      reencode({ ...body, extra: 1 }),
      reencode({ v: 1, t: body.t, id: body.id }),
      reencode([1, 2, 3]),
      Buffer.from('{broken').toString('base64url'),
    ])
      rejects({ cursor });
  });

  it('builds a keyset query: ordered like the index, no OFFSET, no SELECT *, all values as parameters', () => {
    const first = buildHistorySql(ACCOUNT, parseHistoryQuery({}));
    expect(first.sql).toContain('ORDER BY e.created_at DESC, e.id DESC');
    expect(first.sql).not.toMatch(/OFFSET|\*/);
    expect(first.parameters).toEqual([ACCOUNT, 21]);
    const next = buildHistorySql(
      ACCOUNT,
      parseHistoryQuery({
        limit: '5',
        from: '2026-03-14T17:00:00Z',
        to: '2026-03-15T17:00:00Z',
        cursor: cursorOf(
          {},
          { from: '2026-03-14T17:00:00.000000Z', to: '2026-03-15T17:00:00.000000Z' },
        ),
      }),
    );
    expect(next.sql).toContain('(e.created_at, e.id) < ($4::timestamptz, $5::bigint)');
    expect(next.parameters).toEqual([
      ACCOUNT,
      '2026-03-14T17:00:00.000000Z',
      '2026-03-15T17:00:00.000000Z',
      '2026-03-15T02:30:00.123456Z',
      '42',
      6,
    ]);
    // Nothing a client sent is interpolated into the statement text.
    expect(next.sql).not.toMatch(/2026|42/);
  });

  it('never selects a column about fraud, risk or review (AC-10.2)', () => {
    const { sql } = buildHistorySql(ACCOUNT, parseHistoryQuery({}));
    expect(sql).not.toMatch(/fraud|flag|risk|score|review|rule/i);
  });
});
