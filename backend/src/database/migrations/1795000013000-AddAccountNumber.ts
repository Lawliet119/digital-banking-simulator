import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * UI plan, stage A: a customer-facing account number.
 *
 * A UUID is not something a person can type or read out, so a transfer form needs a short number.
 * `accounts.account_number` is 12 digits from `account_number_seq`, starting at 100000000001.
 * A number carries nothing about the customer. It is sequential, though: it shows the order in
 * which accounts were opened, and the next numbers can be guessed. What limits walking through
 * them to collect owner names is the per-customer limit and the audit row of
 * `GET /v1/accounts/lookup`; the limit fails open while Valkey is down.
 *
 * The column has `DEFAULT nextval(...)::text`, so an INSERT that does not know the column (an api
 * image from before this migration during a rolling deploy, a test helper that inserts accounts by
 * hand, `seed.ts`) still gets a number: rolling the application back does not need rolling the
 * schema back. `POST /v1/transfers` still takes account UUIDs; the number only exists to find an
 * account (`GET /v1/accounts/lookup`) and to be shown.
 *
 * Order, and why. One transaction, behind `lock_timeout` like the other migrations that need a lock:
 *   1. The sequence.
 *   2. ADD COLUMN, nullable and without a default: no table rewrite and the lock is short.
 *   3. Backfill the existing rows in `created_at, id` order, one UPDATE, so the oldest account
 *      gets the lowest number. SYSTEM accounts get a number too: the column is NOT NULL for every
 *      row, and `lookup` hides them by `customer_id IS NULL`, not by the column.
 *   4. SET DEFAULT, then NOT NULL, UNIQUE (the index it creates serves the lookup) and the CHECK.
 *   5. GRANT USAGE on the sequence to `dbs_api`: the column default calls `nextval` as the role that
 *      inserts. `dbs_worker` inserts no accounts. `dbs_api` already has SELECT and INSERT on the
 *      table, so it needs no grant on the column.
 *
 * The backfill takes ACCESS EXCLUSIVE through `ALTER TABLE` for as long as the transaction lives;
 * the table is small (about 50,000 rows), but run it as its own pipeline step like the others.
 *
 * `down` runs the steps backwards. The numbers are lost with the column, which is acceptable only
 * because nothing outside the database has been told them yet; once a number has been shown to a
 * customer, do not revert.
 */
export class AddAccountNumber1795000013000 implements MigrationInterface {
  name = 'AddAccountNumber1795000013000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'");
    await queryRunner.query('CREATE SEQUENCE public.account_number_seq START WITH 100000000001');
    await queryRunner.query('ALTER TABLE public.accounts ADD COLUMN account_number text');
    // row_number(), not nextval() in a subquery: the planner may run a volatile subquery more than
    // once per outer row (it did: numbers jumped from ...001 to ...004), so the numbering must not
    // depend on the plan. The sequence is then moved to the last number given.
    await queryRunner.query(`WITH ordered AS (
        SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM public.accounts)
      UPDATE public.accounts a
      SET account_number = (100000000000 + o.n)::text
      FROM ordered o WHERE a.id = o.id`);
    await queryRunner.query(`SELECT setval('public.account_number_seq',
        100000000000 + greatest(count(*), 1), count(*) > 0)
      FROM public.accounts`);
    await queryRunner.query(`ALTER TABLE public.accounts
      ALTER COLUMN account_number SET DEFAULT nextval('public.account_number_seq')::text,
      ALTER COLUMN account_number SET NOT NULL,
      ADD CONSTRAINT accounts_account_number_key UNIQUE (account_number),
      ADD CONSTRAINT accounts_account_number_format CHECK (account_number ~ '^[0-9]{12}$')`);
    await queryRunner.query(
      'ALTER SEQUENCE public.account_number_seq OWNED BY public.accounts.account_number',
    );
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_api') THEN
        GRANT USAGE ON SEQUENCE public.account_number_seq TO dbs_api;
      END IF;
    END $$`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'");
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_api') THEN
        REVOKE USAGE ON SEQUENCE public.account_number_seq FROM dbs_api;
      END IF;
    END $$`);
    await queryRunner.query(`ALTER TABLE public.accounts
      DROP CONSTRAINT accounts_account_number_format,
      DROP CONSTRAINT accounts_account_number_key,
      ALTER COLUMN account_number DROP DEFAULT,
      DROP COLUMN account_number`);
    await queryRunner.query('DROP SEQUENCE IF EXISTS public.account_number_seq');
  }
}
