import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HISTORY_DAYS, MIN_HISTORY_FOR_MEDIAN } from './feature-provider';
import { factQueries } from './transfer-facts';

const DAY_MS = 24 * 3_600_000;

describe('BL-184 H2 history window constants', () => {
  it('are 30 days and 5 rows, the values R2 and the seed rule set require', () => {
    expect(HISTORY_DAYS).toBe(30);
    expect(MIN_HISTORY_FOR_MEDIAN).toBe(5);
  });

  it('match the `historyDays` and `minHistory` of the seeded rule set v1', () => {
    const migration = readFileSync(
      join(__dirname, '../../../database/migrations/1792713600000-CreateFraudStorage.ts'),
      'utf8',
    );
    expect(migration).toContain(
      `historyDays: ${HISTORY_DAYS}, minHistory: ${MIN_HISTORY_FOR_MEDIAN}`,
    );
  });

  it('drive the SQL history window, which starts HISTORY_DAYS before the event', () => {
    const occMs = Date.parse('2026-10-19T12:00:00.000Z');
    const { account } = factQueries('from', 'to', occMs);
    // $2 opens the one scan (30 days before the event); $5 closes the history (the event itself,
    // strictly before it); $3 closes the scan one millisecond later for the 1 h and 24 h windows.
    expect(account.params.slice(0, 3)).toEqual([
      'from',
      new Date(occMs - HISTORY_DAYS * DAY_MS).toISOString(),
      new Date(occMs + 1).toISOString(),
    ]);
    expect(account.params[4]).toBe(new Date(occMs).toISOString());
  });

  it('read count and median from the same rows: one scan of the facts view feeds both (DBS-173)', () => {
    const { sql } = factQueries('from', 'to', 0).account;
    // One scan (`w`) feeds count, median, velocity and outflow; the only other read of the view is
    // the primary-key probe for the current transfer.
    expect(sql.match(/FROM v_transfer_facts/g)).toHaveLength(2);
    expect(sql.match(/FROM w\b/g)).toHaveLength(1);
    expect(sql).toMatch(/count\(\*\) FILTER \(WHERE created_at < \$5::timestamptz\)/);
    expect(sql).toMatch(
      /array_agg\(amount ORDER BY amount\)\s+FILTER \(WHERE created_at < \$5::timestamptz\)/,
    );
  });
});
