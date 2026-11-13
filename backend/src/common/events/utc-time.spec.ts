import { isRealUtcTime } from './utc-time';
import { isRealUtcTime as viaAlias } from '@common/events';

describe('isRealUtcTime (BL-184 H8)', () => {
  it('is the same function through the public index, so consumers need no copy of the calendar check', () => {
    expect(viaAlias).toBe(isRealUtcTime);
  });

  it.each([
    '2026-10-19T03:15:42Z',
    '2026-10-19T03:15:42.1Z',
    '2026-10-19T03:15:42.123456789Z',
    '2024-02-29T00:00:00.000Z', // leap day
    '0099-12-31T12:00:00.000Z', // years below 100 stay as written
    '9999-12-31T23:59:59Z',
  ])('accepts %s', value => {
    expect(isRealUtcTime(value)).toBe(true);
  });

  it.each([
    '2026-02-30T00:00:00Z', // Date.parse would roll this over to 2 March
    '2025-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-10-00T00:00:00Z',
    '2026-10-19T24:00:00Z',
    '2026-10-19T03:60:00Z',
    '2026-10-19T03:15:60Z',
    '2026-10-19T03:15:42+00:00', // offsets are refused, `+00:00` included
    '2026-10-19T03:15:42',
    '2026-10-19T03:15:42.Z',
    '2026-10-19T03:15:42.1234567890Z', // ten fraction digits
    '2026-10-19 03:15:42Z',
    '',
    'garbage',
  ])('rejects %p', value => {
    expect(isRealUtcTime(value)).toBe(false);
  });
});
