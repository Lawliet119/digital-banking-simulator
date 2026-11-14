import { seedInvariantLedger } from '../support/invariant-fixtures';
import { expectLedgerInvariants } from '../support/ledger-invariants';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/** BL-127: the shared helper that money tests call must pass on a clean ledger and fail on a broken one. */
describe('expectLedgerInvariants helper (real PostgreSQL)', () => {
  let db: TempDatabase;

  beforeEach(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
  });
  afterEach(async () => {
    await db?.drop();
  });

  /** The fixture refuses autocommit writes; commit so a second connection sees the ledger too. */
  async function seedCommitted() {
    await db.runner.startTransaction();
    try {
      const refs = await seedInvariantLedger(db.runner);
      await db.runner.commitTransaction();
      return refs;
    } catch (error) {
      await db.runner.rollbackTransaction();
      throw error;
    }
  }

  it('passes on a balanced ledger through a QueryRunner and through its DataSource', async () => {
    const refs = await seedCommitted();
    expect(refs.senderId).toBeDefined();
    const viaRunner = await expectLedgerInvariants(db.runner);
    const viaSource = await expectLedgerInvariants(db.runner.connection);
    expect(viaRunner.status).toBe('PASS');
    expect(viaSource).toEqual(viaRunner);
  });

  it('fails the test and names the account when one balance drifts by one dong', async () => {
    const refs = await seedCommitted();
    await db.runner.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1', [
      refs.senderId,
    ]);
    try {
      await expect(expectLedgerInvariants(db.runner)).rejects.toThrow(refs.senderId);
    } finally {
      await db.runner.query('UPDATE accounts SET balance = balance - 1 WHERE id = $1', [
        refs.senderId,
      ]);
    }
  });
});
