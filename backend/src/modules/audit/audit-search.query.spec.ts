import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import {
  AuditSearchQueryPipe,
  buildAuditSearchSql,
  encodeAuditSearchCursor,
  parseAuditSearchQuery,
} from './audit-search.query';

const ACTOR = 'A1111111-1111-4111-8111-111111111111';
const CORRELATION = 'C2222222-2222-4222-8222-222222222222';
const token = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function validation(raw: unknown): Record<string, unknown> {
  try {
    parseAuditSearchQuery(raw);
    throw new Error('expected a validation failure');
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as Record<string, unknown>;
  }
}

describe('Audit search query (DBS-103)', () => {
  it('TC-103-01 defaults to a bounded page without a history cutoff', () => {
    const parsed = new AuditSearchQueryPipe().transform({});
    expect(parsed).toMatchObject({
      actorUserId: null,
      action: null,
      from: null,
      to: null,
      correlationId: null,
      limit: 50,
      cursor: null,
    });
    expect(buildAuditSearchSql(parsed).parameters).toEqual([51]);
    expect(buildAuditSearchSql(parsed).sql).not.toContain('WHERE');
  });

  it.each([
    ['2024-02-29T23:59:59Z', '2024-02-29T23:59:59.000000Z'],
    ['1970-01-01T00:00:00.1Z', '1970-01-01T00:00:00.100000Z'],
    ['9999-12-31T23:59:59.123456Z', '9999-12-31T23:59:59.123456Z'],
  ])('TC-103-01 normalizes the valid UTC calendar %s', (from, expected) => {
    expect(parseAuditSearchQuery({ from }).from).toBe(expected);
  });

  it('TC-103-01 normalizes UUIDs but retains the exact action', () => {
    expect(
      parseAuditSearchQuery({ actorUserId: ACTOR, correlationId: CORRELATION, action: ' Read ' }),
    ).toMatchObject({
      actorUserId: ACTOR.toLowerCase(),
      correlationId: CORRELATION.toLowerCase(),
      action: ' Read ',
    });
    expect(parseAuditSearchQuery({ limit: '1' }).limit).toBe(1);
    expect(parseAuditSearchQuery({ limit: '100' }).limit).toBe(100);
  });

  it.each([
    null,
    undefined,
    [],
    'limit=1',
    { unknown: 'private-probe@example.invalid' },
    { limit: ['1', '2'] },
    { actorUserId: {} },
    { action: ['read'] },
    { 'limit[]': '1' },
    { 'actorUserId[id]': ACTOR },
    { limit: 1 },
  ])('TC-103-02 rejects malformed/unknown/non-scalar queries %#', raw => {
    const response = validation(raw);
    expect(response.errorCode).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain('private-probe');
    expect(response.errors).toEqual(expect.arrayContaining([expect.any(String)]));
  });

  it.each(['', 'null', 'bad', `${ACTOR}\n`, '11111111-1111-1111-1111-11111111111'])(
    'TC-103-02 rejects invalid UUID %#',
    actorUserId => {
      validation({ actorUserId });
      validation({ correlationId: actorUserId });
    },
  );

  it.each(['', ' ', '\t', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a'.repeat(129)])(
    'TC-103-02 rejects invalid action %#',
    action => {
      validation({ action });
    },
  );

  it.each([
    '2026-02-29T00:00:00Z',
    '2100-02-29T00:00:00Z',
    '1969-12-31T23:59:59Z',
    '10000-01-01T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00.1234567Z',
    '2026-01-01T00:00:00+00:00',
    '2026-01-01T00:00:00Z\n',
    'infinity',
  ])('TC-103-02 rejects invalid calendar/time %#', from => {
    validation({ from });
    validation({ to: from });
  });

  it.each(['0', '101', '01', '-1', '+1', '1.0', '1e1', '', ' 1', '1\n'])(
    'TC-103-02 rejects noncanonical page size %#',
    limit => {
      validation({ limit });
    },
  );

  it.each([
    ['2026-11-04T08:00:00Z', '2026-11-04T08:00:00.000000Z'],
    ['2026-11-04T08:00:00.123456Z', '2026-11-04T08:00:00.123455Z'],
  ])('TC-103-02 rejects an empty/reversed interval %#', (from, to) => {
    validation({ from, to });
  });

  it('TC-103-03 binds a cursor to normalized filters in fixed key order, excluding limit', () => {
    const filters = {
      actorUserId: ACTOR,
      action: 'read',
      from: '2026-11-04T08:00:00.1Z',
      correlationId: CORRELATION,
    };
    const parsed = parseAuditSearchQuery(filters);
    const cursor = encodeAuditSearchCursor(
      { id: '9007199254740993', occurredAt: '2026-11-04T08:10:00.123456Z' },
      parsed,
    );
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(decoded).toEqual({
      v: 1,
      t: '2026-11-04T08:10:00.123456Z',
      id: '9007199254740993',
      f: createHash('sha256')
        .update(
          JSON.stringify({
            actorUserId: ACTOR.toLowerCase(),
            action: 'read',
            from: '2026-11-04T08:00:00.100000Z',
            to: null,
            correlationId: CORRELATION.toLowerCase(),
          }),
        )
        .digest('hex'),
    });
    expect(
      parseAuditSearchQuery({
        ...filters,
        actorUserId: ACTOR.toLowerCase(),
        from: '2026-11-04T08:00:00.100000Z',
        limit: '1',
        cursor,
      }).cursor,
    ).toEqual(decoded);
    validation({ ...filters, action: 'READ', cursor });
    validation({ ...filters, correlationId: ACTOR, cursor });
    validation({ cursor });
  });

  it('TC-103-03 preserves the maximum bigint ID and six microsecond digits', () => {
    const query = parseAuditSearchQuery({});
    const cursor = encodeAuditSearchCursor(
      { id: '9223372036854775807', occurredAt: '9999-12-31T23:59:59.999999Z' },
      query,
    );
    expect(parseAuditSearchQuery({ cursor }).cursor?.id).toBe('9223372036854775807');
  });

  it.each([
    '',
    '!',
    'a'.repeat(513),
    'e30=',
    'e30+',
    'e30/',
    token('private-probe@example.invalid'),
    token([]),
    token(null),
    'ew',
  ])('TC-103-03 rejects malformed/noncanonical cursor %#', cursor => {
    expect(JSON.stringify(validation({ cursor }))).not.toContain('private-probe');
  });

  it.each([
    { v: 2 },
    { v: '1' },
    { extra: true },
    { id: '0' },
    { id: '01' },
    { id: '+1' },
    { id: '1\n' },
    { id: '9223372036854775808' },
    { id: 9 },
    { t: '2026-11-04T08:00:00Z' },
    { t: '2026-02-29T08:00:00.000000Z' },
    { f: 'A'.repeat(64) },
    { f: '0'.repeat(64) },
  ])('TC-103-03 rejects invalid payload field %#', override => {
    const query = parseAuditSearchQuery({});
    const good = JSON.parse(
      Buffer.from(
        encodeAuditSearchCursor({ id: '10', occurredAt: '2026-11-04T08:00:00.000000Z' }, query),
        'base64url',
      ).toString('utf8'),
    ) as Record<string, unknown>;
    validation({ cursor: token({ ...good, ...override }) });
    const { f: _f, ...missing } = good;
    validation({ cursor: token(missing) });
  });

  it('TC-103-08/14 builds parameterized numeric keyset SQL with exact UTC projection', () => {
    const action = "transfer.create' OR 1=1 --";
    const raw = {
      actorUserId: ACTOR,
      action,
      from: '2026-11-04T08:00:00Z',
      to: '2026-11-04T09:00:00Z',
      correlationId: CORRELATION,
      limit: '2',
    };
    const query = parseAuditSearchQuery(raw);
    const cursor = encodeAuditSearchCursor(
      { id: '10000000000000000', occurredAt: '2026-11-04T08:10:00.123456Z' },
      query,
    );
    const built = buildAuditSearchSql(parseAuditSearchQuery({ ...raw, cursor }));
    expect(built.sql).toContain('FROM audit_log a');
    expect(built.sql).toContain('ORDER BY a.occurred_at DESC, a.id DESC');
    expect(built.sql).toContain('(a.occurred_at, a.id) < ($6::timestamptz, $7::bigint)');
    expect(built.sql).toContain('\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\'');
    expect(built.sql).toContain('a.occurred_at >= $3::timestamptz');
    expect(built.sql).toContain('a.occurred_at < $4::timestamptz');
    expect(built.sql).not.toContain(action);
    expect(built.sql).not.toContain('OFFSET');
    expect(built.parameters).toEqual([
      ACTOR.toLowerCase(),
      action,
      '2026-11-04T08:00:00.000000Z',
      '2026-11-04T09:00:00.000000Z',
      CORRELATION.toLowerCase(),
      '2026-11-04T08:10:00.123456Z',
      '10000000000000000',
      3,
    ]);
  });
});
