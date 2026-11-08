import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { loadDailyDebitLedger, planNodes } from '../support/daily-debit-fixture';
import {
  buildHistorySql,
  encodeHistoryCursor,
  parseHistoryQuery,
} from '../../src/modules/ledger/transaction-history.query';

/**
 * DBS-87 DoD #1: page one of the history (20 lines) is an Index Scan on
 * ledger_entries_account_history_idx with no Sort, and so is every page after it. The timing
 * (<= 20 ms on a million lines) is measured by scripts/manual-dbs87.cjs, not here: a time limit
 * in CI would be flaky, a plan is not.
 */
describe('TC-87-03 history pages are index scans without a Sort', () => {
  let db: TempDatabase, hotAccountId: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    await db.runner.startTransaction();
    ({ hotAccountId } = await loadDailyDebitLedger(db.runner, {
      hotRows: 100_000,
      noiseRows: 100_000,
      noiseAccounts: 500,
      todayRows: 50,
      spanDays: 730,
    }));
    await db.runner.commitTransaction();
    await q('VACUUM (ANALYZE) ledger_entries');
    await q('VACUUM (ANALYZE) transfers');
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  });

  async function plan(query: Record<string, string>) {
    const { sql, parameters } = buildHistorySql(hotAccountId, parseHistoryQuery(query));
    const [{ 'QUERY PLAN': explain }] = await q(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      parameters,
    );
    return planNodes(explain[0]);
  }
  function expectIndexOrder(nodes: Record<string, unknown>[]) {
    const kinds = nodes.map(n => n['Node Type']);
    expect(kinds).not.toContain('Sort');
    expect(kinds).not.toContain('Incremental Sort');
    expect(kinds).not.toContain('Seq Scan');
    expect(kinds).not.toContain('Bitmap Heap Scan');
    const scan = nodes.find(n => n['Index Name'] === 'ledger_entries_account_history_idx');
    expect(scan).toBeDefined();
    expect(['Index Scan', 'Index Only Scan']).toContain(scan!['Node Type']);
    expect(scan!['Scan Direction']).toBe('Forward'); // the index is already (created_at DESC, id DESC)
  }

  it('page one: 20 lines', async () => {
    const nodes = await plan({ limit: '20' });
    expectIndexOrder(nodes);
    // The LIMIT stops the scan: it reads about a page of the million-line account, not all of it.
    const scan = nodes.find(n => n['Index Name'] === 'ledger_entries_account_history_idx')!;
    expect(Number(scan['Actual Rows'])).toBeLessThanOrEqual(21);
  });

  it('page two: the keyset condition is an index condition, not a filter or a Sort', async () => {
    const { sql, parameters } = buildHistorySql(hotAccountId, parseHistoryQuery({ limit: '20' }));
    const rows: { entryId: string; createdAt: string }[] = await q(sql, parameters);
    const last = rows[19];
    const nodes = await plan({
      limit: '20',
      cursor: encodeHistoryCursor(last, { from: null, to: null }),
    });
    expectIndexOrder(nodes);
    const scan = nodes.find(n => n['Index Name'] === 'ledger_entries_account_history_idx')!;
    expect(String(scan['Index Cond'])).toMatch(/created_at/);
    expect(Number(scan['Actual Rows'])).toBeLessThanOrEqual(21);
  });

  it('a time window keeps the index order', async () => {
    const nodes = await plan({
      limit: '20',
      from: '2025-11-01T00:00:00Z',
      to: '2026-11-01T00:00:00Z',
    });
    expectIndexOrder(nodes);
  });
});
