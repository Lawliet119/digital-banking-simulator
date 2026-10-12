import type { QueryRunner } from 'typeorm';
import { attempt, createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

// DBS-20: the database itself protects the account invariants (database-design §4.1, §4.2, §5).
// Every rejection is asserted by SQLSTATE and constraint name, never by message text. Each bad
// row breaks exactly one constraint: PostgreSQL checks CHECK constraints in name order, so a row
// breaking two would report whichever name sorts first.

const FUNDING_ID = '00000000-0000-4000-8000-000000000001';

describe('migration 1: users, customers, accounts', () => {
  let db: TempDatabase;
  let runner: QueryRunner;

  beforeAll(async () => {
    db = await createTempDatabase();
    runner = db.runner;
    await migrate(db.url);
  });

  afterAll(async () => {
    await db?.drop();
  });

  // Every case runs in a transaction that is rolled back, so the cases do not see each other.
  beforeEach(() => runner.query('BEGIN'));
  afterEach(() => runner.query('ROLLBACK'));

  async function newUser(sub = `sub-${Math.random()}`): Promise<string> {
    const rows = await attempt<{ id: string }>(
      runner,
      'INSERT INTO users (cognito_sub) VALUES ($1) RETURNING id',
      [sub],
    );
    return rows[0].id;
  }

  async function newCustomer(userId?: string): Promise<string> {
    const rows = await attempt<{ id: string }>(
      runner,
      'INSERT INTO customers (user_id, full_name) VALUES ($1, $2) RETURNING id',
      [userId ?? (await newUser()), 'Nguyen Van A'],
    );
    return rows[0].id;
  }

  function insertAccount(row: {
    customerId: string | null;
    type: string;
    status?: string;
    balance?: string;
  }) {
    return attempt<{ id: string; balance: string }>(
      runner,
      `INSERT INTO accounts (customer_id, type, status, balance)
       VALUES ($1, $2, $3, $4) RETURNING id, balance`,
      [row.customerId, row.type, row.status ?? 'ACTIVE', row.balance ?? '0'],
    );
  }

  describe('shape', () => {
    it('TC-20-01 has exactly the designed columns, types, nullability and defaults', async () => {
      const rows = await runner.query(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name IN ('users', 'customers', 'accounts')
          ORDER BY table_name, ordinal_position`,
      );

      const col = (
        table: string,
        column: string,
        type: string,
        nullable: 'YES' | 'NO',
        def: string | null,
      ) => ({
        table_name: table,
        column_name: column,
        data_type: type,
        is_nullable: nullable,
        column_default: def,
      });
      const tz = 'timestamp with time zone';
      expect(rows).toEqual([
        col('accounts', 'id', 'uuid', 'NO', 'gen_random_uuid()'),
        col('accounts', 'customer_id', 'uuid', 'YES', null),
        col('accounts', 'type', 'text', 'NO', null),
        col('accounts', 'status', 'text', 'NO', "'ACTIVE'::text"),
        col('accounts', 'balance', 'bigint', 'NO', '0'),
        col('accounts', 'created_at', tz, 'NO', 'now()'),
        col('accounts', 'updated_at', tz, 'NO', 'now()'),
        col('customers', 'id', 'uuid', 'NO', 'gen_random_uuid()'),
        col('customers', 'user_id', 'uuid', 'NO', null),
        col('customers', 'full_name', 'text', 'NO', null),
        col('customers', 'created_at', tz, 'NO', 'now()'),
        col('users', 'id', 'uuid', 'NO', 'gen_random_uuid()'),
        col('users', 'cognito_sub', 'text', 'NO', null),
        col('users', 'sessions_revoked_at', tz, 'YES', null),
        col('users', 'created_at', tz, 'NO', 'now()'),
      ]);
    });

    it('TC-20-02 has no time column without time zone and no non-bigint number column', async () => {
      const rows = await runner.query(
        `SELECT table_name, column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name IN ('users', 'customers', 'accounts')
            AND data_type IN ('timestamp without time zone', 'date', 'time without time zone',
                              'numeric', 'real', 'double precision', 'integer', 'smallint')`,
      );

      expect(rows).toEqual([]);
    });

    it('TC-20-15 accounts: fillfactor 80, partial indexes, RESTRICT foreign keys', async () => {
      const rel = await runner.query(
        `SELECT reloptions FROM pg_class WHERE oid = 'accounts'::regclass`,
      );
      expect(rel[0].reloptions).toEqual(['fillfactor=80']);

      const idx = await runner.query(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'accounts' AND indexname <> 'accounts_pkey' ORDER BY indexname`,
      );
      expect(idx).toEqual([
        {
          indexname: 'accounts_customer_idx',
          indexdef:
            'CREATE INDEX accounts_customer_idx ON public.accounts USING btree (customer_id) ' +
            'WHERE (customer_id IS NOT NULL)',
        },
        {
          indexname: 'accounts_single_system',
          indexdef:
            'CREATE UNIQUE INDEX accounts_single_system ON public.accounts USING btree (type) ' +
            "WHERE (type = 'SYSTEM'::text)",
        },
      ]);

      // 23503 alone cannot tell RESTRICT from NO ACTION; the catalog can ('r' = RESTRICT).
      const fks = await runner.query(
        `SELECT conname, confdeltype FROM pg_constraint
          WHERE contype = 'f' AND conrelid IN ('customers'::regclass, 'accounts'::regclass)
          ORDER BY conname`,
      );
      expect(fks).toEqual([
        { conname: 'accounts_customer_id_fkey', confdeltype: 'r' },
        { conname: 'customers_user_id_fkey', confdeltype: 'r' },
      ]);
    });
  });

  describe('funding account seed', () => {
    it('TC-20-12 creates exactly one SYSTEM funding account with the fixed id, and no users', async () => {
      const rows = await runner.query(
        'SELECT id, customer_id, type, status, balance FROM accounts',
      );
      expect(rows).toEqual([
        { id: FUNDING_ID, customer_id: null, type: 'SYSTEM', status: 'ACTIVE', balance: '0' },
      ]);

      const counts = await runner.query(
        'SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM customers)::int AS customers',
      );
      expect(counts[0]).toEqual({ users: 0, customers: 0 });
    });
  });

  describe('users and customers', () => {
    it('TC-20-03 rejects a second user with the same cognito_sub', async () => {
      await newUser('sub-a');

      await expect(newUser('sub-a')).rejects.toMatchObject({
        code: '23505',
        constraint: 'users_cognito_sub_key',
      });
    });

    it('TC-20-04 rejects a second customer for the same user', async () => {
      const userId = await newUser();
      await newCustomer(userId);

      await expect(newCustomer(userId)).rejects.toMatchObject({
        code: '23505',
        constraint: 'customers_user_id_key',
      });
    });

    it('TC-20-05 rejects dangling references and deleting a referenced row', async () => {
      const missing = '11111111-1111-4111-8111-111111111111';
      await expect(newCustomer(missing)).rejects.toMatchObject({
        code: '23503',
        constraint: 'customers_user_id_fkey',
      });
      await expect(insertAccount({ customerId: missing, type: 'CHECKING' })).rejects.toMatchObject({
        code: '23503',
        constraint: 'accounts_customer_id_fkey',
      });

      const userId = await newUser();
      const customerId = await newCustomer(userId);
      await insertAccount({ customerId, type: 'CHECKING' });

      await expect(
        attempt(runner, 'DELETE FROM users WHERE id = $1', [userId]),
      ).rejects.toMatchObject({ code: '23503', constraint: 'customers_user_id_fkey' });
      await expect(
        attempt(runner, 'DELETE FROM customers WHERE id = $1', [customerId]),
      ).rejects.toMatchObject({ code: '23503', constraint: 'accounts_customer_id_fkey' });
    });
  });

  describe('accounts', () => {
    it('TC-20-06 rejects a negative customer balance, on insert and on update; 0 is allowed', async () => {
      const customerId = await newCustomer();

      await expect(
        insertAccount({ customerId, type: 'CHECKING', balance: '-1' }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'accounts_balance_non_negative' });

      const rows = await insertAccount({ customerId, type: 'CHECKING', balance: '0' });
      const id = rows[0].id;
      await attempt(runner, 'UPDATE accounts SET balance = 100 WHERE id = $1', [id]);

      await expect(
        attempt(runner, 'UPDATE accounts SET balance = -1 WHERE id = $1', [id]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'accounts_balance_non_negative' });
    });

    it('TC-20-07 lets the SYSTEM funding account go negative (ADR-09)', async () => {
      // A direct balance UPDATE only to probe the constraint: no deposit API exists yet.
      await attempt(runner, 'UPDATE accounts SET balance = -500 WHERE id = $1', [FUNDING_ID]);

      const rows = await runner.query('SELECT balance FROM accounts WHERE id = $1', [FUNDING_ID]);
      expect(rows[0]).toEqual({ balance: '-500' });
    });

    it('TC-20-08 rejects a second SYSTEM account', async () => {
      await expect(insertAccount({ customerId: null, type: 'SYSTEM' })).rejects.toMatchObject({
        code: '23505',
        constraint: 'accounts_single_system',
      });
    });

    it('TC-20-09 rejects a SYSTEM account that has a customer', async () => {
      const customerId = await newCustomer();

      await expect(insertAccount({ customerId, type: 'SYSTEM' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'accounts_owner_matches_type',
      });
    });

    it('TC-20-10 rejects a CHECKING or SAVINGS account without a customer', async () => {
      for (const type of ['CHECKING', 'SAVINGS']) {
        await expect(insertAccount({ customerId: null, type })).rejects.toMatchObject({
          code: '23514',
          constraint: 'accounts_owner_matches_type',
        });
      }
    });

    it('TC-20-11 rejects an unknown type or status', async () => {
      const customerId = await newCustomer();

      for (const type of ['CREDIT', 'checking']) {
        await expect(insertAccount({ customerId, type })).rejects.toMatchObject({
          code: '23514',
          constraint: 'accounts_type_check',
        });
      }
      await expect(
        insertAccount({ customerId, type: 'CHECKING', status: 'CLOSED' }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'accounts_status_check' });
    });

    it('TC-20-14 keeps an amount above 2^53 exact, as a string', async () => {
      const customerId = await newCustomer();

      const rows = await insertAccount({
        customerId,
        type: 'CHECKING',
        balance: '9007199254740993',
      });

      expect(rows[0].balance).toBe('9007199254740993');
    });

    it('TC-20-19 stores the bigint maximum and refuses to overflow it', async () => {
      const customerId = await newCustomer();
      const rows = await insertAccount({
        customerId,
        type: 'SAVINGS',
        balance: '9223372036854775807',
      });
      const { id, balance } = rows[0];
      expect(balance).toBe('9223372036854775807');

      await expect(
        attempt(runner, 'UPDATE accounts SET balance = balance + 1 WHERE id = $1', [id]),
      ).rejects.toMatchObject({ code: '22003' });
    });
  });
});
