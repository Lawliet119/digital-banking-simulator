import { describe, expect, it } from 'vitest';
import { formatDateTime, vietnamDayEnd, vietnamDayStart } from './dates';

describe('Vietnam day bounds', () => {
  it('starts a day at 17:00 UTC of the day before', () => {
    expect(vietnamDayStart('2026-03-15')).toBe('2026-03-14T17:00:00.000Z');
  });

  it('ends a day at the start of the next one (exclusive)', () => {
    expect(vietnamDayEnd('2026-03-15')).toBe('2026-03-15T17:00:00.000Z');
    expect(vietnamDayEnd('2026-12-31')).toBe('2026-12-31T17:00:00.000Z');
  });

  it.each(['', '2026-3-5', '2026-02-30', '2026-13-01', 'yesterday'])('refuses %j', day => {
    expect(vietnamDayStart(day)).toBeNull();
    expect(vietnamDayEnd(day)).toBeNull();
  });
});

describe('formatDateTime', () => {
  it('shows Vietnam time', () => {
    expect(formatDateTime('2026-03-14T17:30:00.000000Z')).toContain('00:30:00');
  });

  it('returns a malformed value unchanged', () => {
    expect(formatDateTime('not a date')).toBe('not a date');
  });
});
