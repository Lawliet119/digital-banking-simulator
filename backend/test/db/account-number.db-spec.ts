import {
  attempt,
  createTempDatabase,
  migrate,
  migrateThrough,
  type TempDatabase,
} from '../support/temp-database';

/**
 * UI plan, stage A: `accounts.account_number`, 12 digits from `account_number_seq`.
 * Rejections are asserted by SQLSTATE and constraint name, never by message text.
 */
const PREVIOUS = 'AddDailyDebitCounter1795000012000';
const THIS = 'AddAccountNumber1795000013000';

async function newCustomer(db: TempDatabase): Promise<string> {
  const [user] = await db.runner.query('INSERT INTO users (cognito_sub) VALUES ($1) RETURNING id', [
    `sub-${Math.random()}`,
  ]);
  const [customer] = await db.runner.query(
    'INSERT INTO customers (user_id, full_name) VALUES ($1, $2) RETURNING id',
    [user.id, 'Nguyen Van A'],
  );
  return (customer as { id: string }).id;
}

describe('UI stage A: accounts.account_number', () => {
  describe('backfill of rows that existed before the migration', () => {
    let db: TempDatabase;
    let oldIds: string[];

    beforeAll(async () => {
      db = await createTempDatabase();
      await migrateThrough(db.url, PREVIOUS);
      const customer = await newCustomer(db);
      // Inserted newest first on purpose: the numbers must follow created_at, not insertion order.
      oldIds = [];
      for (const [type, createdAt] of [
        ['SAVINGS', '2026-01-03T00:00:00Z'],
        ['CHECKING', '2026-01-01T00:00:00Z'],
        ['CHECKING', '2026-01-02T00:00:00Z'],
      ]) {
        const [row] = await db.runner.query(
          'INSERT INTO accounts (customer_id, type, created_at) VALUES ($1, $2, $3) RETURNING id',
          [customer, type, createdAt],
        );
        oldIds.push(row.id);
      }
      await migrate(db.url);
    });
    afterAll(async () => {
      await db?.drop();
    });

    it('TC-A-01 gives every old row a number in created_at, id order, starting at 100000000001', async () => {
      const rows: { id: string; account_number: string }[] = await db.runner.query(
        'SELECT id, account_number FROM accounts ORDER BY created_at, id',
      );
      expect(rows.map(r => r.account_number)).toEqual(rows.map((_, i) => String(100000000001 + i)));
      // The SYSTEM funding account (created by migration 1) is the oldest, so it has the first one.
      expect(rows[0].account_number).toBe('100000000001');
      // The three rows above come out as: 2026-01-01, 2026-01-02, 2026-01-03.
      const byOld = Object.fromEntries(rows.map(r => [r.id, r.account_number]));
      const [saving, first, second] = oldIds;
      expect([first, second, saving].map(id => Number(byOld[id]))).toEqual(
        [first, second, saving].map(id => Number(byOld[id])).sort((a, b) => a - b),
      );
    });

    it('TC-A-02 the next account continues the sequence (no reuse of a backfilled number)', async () => {
      const customer = await newCustomer(db);
      const [{ count }] = await db.runner.query('SELECT count(*)::int AS count FROM accounts');
      const [row] = await db.runner.query(
        'INSERT INTO accounts (customer_id, type) VALUES ($1, $2) RETURNING account_number',
        [customer, 'CHECKING'],
      );
      expect(row.account_number).toBe(String(100000000001 + count));
    });
  });

  describe('on the final schema', () => {
    let db: TempDatabase;
    let customer: string;
    beforeAll(async () => {
      db = await createTempDatabase();
      await migrate(db.url);
      customer = await newCustomer(db);
    });
    afterAll(async () => {
      await db?.drop();
    });
    beforeEach(() => db.runner.query('BEGIN'));
    afterEach(() => db.runner.query('ROLLBACK'));

    it('TC-A-03 an INSERT that does not name the column still gets a 12-digit number', async () => {
      const [row] = await attempt<{ account_number: string }>(
        db.runner,
        'INSERT INTO accounts (customer_id, type) VALUES ($1, $2) RETURNING account_number',
        [customer, 'CHECKING'],
      );
      expect(row.account_number).toMatch(/^[0-9]{12}$/);
    });

    it('TC-A-04 two accounts never share a number: UNIQUE rejects a duplicate', async () => {
      const [first] = await attempt<{ account_number: string }>(
        db.runner,
        'INSERT INTO accounts (customer_id, type) VALUES ($1, $2) RETURNING account_number',
        [customer, 'CHECKING'],
      );
      await expect(
        attempt(
          db.runner,
          'INSERT INTO accounts (customer_id, type, account_number) VALUES ($1, $2, $3)',
          [customer, 'SAVINGS', first.account_number],
        ),
      ).rejects.toMatchObject({
        driverError: { code: '23505', constraint: 'accounts_account_number_key' },
      });
    });

    it.each(['12345678901', '1234567890123', 'abcdefghijkl', '10000000000a', ' 00000000001'])(
      'TC-A-05 CHECK rejects the malformed number %j',
      async bad => {
        await expect(
          attempt(
            db.runner,
            'INSERT INTO accounts (customer_id, type, account_number) VALUES ($1, $2, $3)',
            [customer, 'CHECKING', bad],
          ),
        ).rejects.toMatchObject({
          driverError: { code: '23514', constraint: 'accounts_account_number_format' },
        });
      },
    );

    it('TC-A-06 NOT NULL: an explicit NULL is refused', async () => {
      await expect(
        attempt(
          db.runner,
          'INSERT INTO accounts (customer_id, type, account_number) VALUES ($1, $2, NULL)',
          [customer, 'CHECKING'],
        ),
      ).rejects.toMatchObject({ driverError: { code: '23502' } });
    });

    it('TC-A-07 dbs_api opens an account (the column default calls nextval as dbs_api) but cannot change a number', async () => {
      await db.runner.query('SET LOCAL ROLE dbs_api');
      const [row] = await attempt<{ id: string; account_number: string }>(
        db.runner,
        'INSERT INTO accounts (customer_id, type) VALUES ($1, $2) RETURNING id, account_number',
        [customer, 'SAVINGS'],
      );
      expect(row.account_number).toMatch(/^[0-9]{12}$/);
      await expect(
        attempt(db.runner, "UPDATE accounts SET account_number = '999999999999' WHERE id = $1", [
          row.id,
        ]),
      ).rejects.toMatchObject({ driverError: { code: '42501' } });
      await expect(
        attempt(db.runner, "SELECT setval('public.account_number_seq', 1)"),
      ).rejects.toMatchObject({ driverError: { code: '42501' } });
    });

    it('TC-A-08 dbs_worker has no grant on the sequence', async () => {
      await db.runner.query('SET LOCAL ROLE dbs_worker');
      await expect(
        attempt(db.runner, "SELECT nextval('public.account_number_seq')"),
      ).rejects.toMatchObject({ driverError: { code: '42501' } });
    });

    // The catalogue, not an EXPLAIN: the migration backfills and indexes in one transaction, so
    // PostgreSQL may hold the new index back from a snapshot older than it (indcheckxmin) while
    // other suites keep transactions open on the same cluster, and the plan then depends on timing.
    it('TC-A-09 a valid unique btree on account_number serves the exact lookup', async () => {
      const rows = await db.runner.query(
        `SELECT am.amname AS method, i.indisunique AS "unique", i.indisvalid AS valid,
                pg_get_indexdef(i.indexrelid, 1, true) AS first_column, i.indnatts AS columns
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_am am ON am.oid = c.relam
         WHERE c.relname = 'accounts_account_number_key'`,
      );
      expect(rows).toEqual([
        {
          method: 'btree',
          unique: true,
          valid: true,
          first_column: 'account_number',
          columns: 1,
        },
      ]);
    });
  });

  describe('revert', () => {
    it('TC-A-10 down removes column and sequence, keeps the rows, and up runs again', async () => {
      const db = await createTempDatabase();
      try {
        // Stop at this migration, so undoLast reverts it even after newer ones are added.
        await migrateThrough(db.url, THIS);
        const customer = await newCustomer(db);
        await db.runner.query('INSERT INTO accounts (customer_id, type) VALUES ($1, $2)', [
          customer,
          'CHECKING',
        ]);
        const [{ before }] = await db.runner.query('SELECT count(*)::int AS before FROM accounts');

        await migrate(db.url, 'undoLast');
        const gone = await db.runner.query(
          `SELECT
             (SELECT count(*) FROM information_schema.columns
               WHERE table_name = 'accounts' AND column_name = 'account_number')::int AS columns,
             (SELECT count(*) FROM pg_class WHERE relname = 'account_number_seq')::int AS sequences`,
        );
        expect(gone).toEqual([{ columns: 0, sequences: 0 }]);
        const [{ after }] = await db.runner.query('SELECT count(*)::int AS after FROM accounts');
        expect(after).toBe(before);

        await migrate(db.url);
        const rows: { account_number: string }[] = await db.runner.query(
          'SELECT account_number FROM accounts ORDER BY created_at, id',
        );
        expect(rows.map(r => r.account_number)).toEqual(
          rows.map((_, i) => String(100000000001 + i)),
        );
      } finally {
        await db.drop();
      }
    });
  });
});
