import type { QueryRunner } from 'typeorm';
import { checkLedgerInvariants, type LedgerInvariantReport } from './invariants';

/** A TypeORM `DataSource` or `QueryRunner`: anything that runs one text query and returns rows. */
export interface LedgerQueryable {
  query(sql: string): Promise<unknown>;
}

/**
 * BL-127: run the DBS-69 checker (one SELECT, no side effect) and fail the test with the violation
 * list when the ledger is not clean. Call it at the end of a money test, or through
 * {@link expectLedgerInvariantsAfterEach}, so a test that moves money proves the books still balance.
 *
 * The checker reads the whole ledger; on a test database that is a few milliseconds.
 */
export async function expectLedgerInvariants(
  target: LedgerQueryable,
): Promise<LedgerInvariantReport> {
  const report = await checkLedgerInvariants(target as unknown as Pick<QueryRunner, 'query'>);
  expect(report.violations).toEqual([]);
  expect(report.status).toBe('PASS');
  expect(report.totals.balance).toBe('0');
  return report;
}

/**
 * Registers an `afterEach` in the calling `describe` that checks the ledger after every test. The
 * target is a getter because the database exists only after `beforeAll`/`beforeEach`; the check is
 * skipped while it returns `undefined` (setup failed, nothing to check).
 */
export function expectLedgerInvariantsAfterEach(
  target: () => LedgerQueryable | undefined | null,
): void {
  afterEach(async () => {
    const current = target();
    if (current) await expectLedgerInvariants(current);
  });
}
