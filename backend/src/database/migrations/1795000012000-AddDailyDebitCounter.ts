import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BL-418: the day total of the daily limit (BR-06) lives on the account row.
 *
 * The guard used to run `SELECT sum(amount) FROM ledger_entries WHERE account_id=$1 AND
 * direction='DEBIT' AND created_at >= <Vietnam midnight>` after the two account rows were locked,
 * so the row locks were held for as long as that sum took: O(the debit lines of the account today),
 * 1.9 ms at the 120 RPS baseline on RDS and 9.6 ms at ~47,000 lines (DBS-173). The guard now reads
 * the total from the row it has just locked.
 *
 * `sent_day` is the LATEST Vietnam day that has a DEBIT line of the account (by
 * `ledger_entries.created_at`, the column the old SUM filtered on) and `sent_today` is the sum of
 * that day's lines. They are derived data: the ledger stays the source of truth, and the invariant
 * check `daily_debit_totals` (DBS-69) compares the two.
 *
 * Why a trigger and not "the application adds to it in the balance UPDATE": during a rolling
 * deploy an api task that does not know the columns still writes DEBIT lines, and a counter that
 * only new code maintains would then miss them and let a customer pass the daily limit. A trigger
 * counts every line whoever writes it, in the same transaction (so a rollback or a deadlock retry
 * undoes it), and `dbs_api` needs no new grant: its UPDATE on `accounts` is column-level
 * (balance, status, updated_at), so the application cannot touch the counter at all.
 *
 * The trigger is per STATEMENT with a transition table: a fixture or seed that inserts 100,000
 * lines in one statement updates the account row once, not 100,000 times inside one transaction.
 * It is one atomic UPDATE (`sent_today + total` is evaluated again on the newest version of the row
 * when two writers meet, at READ COMMITTED), it never moves `sent_day` back, and SYSTEM accounts
 * (the funding account is the debit side of every deposit) are left out.
 *
 * Order, and why. Everything below runs in this migration's one transaction, behind `lock_timeout`
 * like the other migrations that need a lock:
 *   1. ALTER TABLE accounts: ACCESS EXCLUSIVE. It waits for every transfer and deposit in flight
 *      (they hold row locks on accounts) and, while it waits, new ones queue behind it. A transfer
 *      that already holds a lock on accounts still gets through to write its ledger lines and commit.
 *   2. The function and the trigger. Taken after step 1 so no ledger writer can be in the middle of
 *      a transaction: it would deadlock if the order were the other way round (a transfer holds an
 *      accounts row and waits for the lock on ledger_entries that CREATE TRIGGER needs).
 *   3. The backfill, last, so it sees every line committed before this transaction commits and the
 *      trigger counts every line after it.
 * While the migration holds the ACCESS EXCLUSIVE lock (the backfill reads every DEBIT line once)
 * the api cannot lock any account: run it as its own pipeline step before the image that reads the
 * columns, outside the busy hours. Time it on a big ledger: BL-418 feature doc, M-418-05.
 *
 * `down` drops the trigger, the function and both columns. Nothing is lost: the counter can always
 * be rebuilt from `ledger_entries` (the backfill below).
 */
const TZ = 'Asia/Ho_Chi_Minh';

export class AddDailyDebitCounter1795000012000 implements MigrationInterface {
  name = 'AddDailyDebitCounter1795000012000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'");

    await queryRunner.query(`ALTER TABLE accounts
      ADD COLUMN sent_today bigint NOT NULL DEFAULT 0,
      ADD COLUMN sent_day date,
      ADD CONSTRAINT accounts_sent_today_non_negative CHECK (sent_today >= 0),
      ADD CONSTRAINT accounts_sent_day_when_sent CHECK (sent_day IS NOT NULL OR sent_today = 0)`);

    await queryRunner.query(`CREATE FUNCTION public.add_daily_debit() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        -- Lock the accounts in id order, as lockForUpdate does: two bulk inserts that touch the
        -- same accounts must not deadlock on the order the planner happens to pick.
        PERFORM 1 FROM public.accounts a
          WHERE a.type <> 'SYSTEM'
            AND a.id IN (SELECT n.account_id FROM new_rows n WHERE n.direction = 'DEBIT')
          ORDER BY a.id FOR UPDATE;
        WITH per_day AS (
          SELECT n.account_id, (n.created_at AT TIME ZONE '${TZ}')::date AS d, sum(n.amount) AS total
          FROM new_rows n WHERE n.direction = 'DEBIT' GROUP BY 1, 2),
        latest AS (
          SELECT DISTINCT ON (account_id) account_id, d, total FROM per_day
          ORDER BY account_id, d DESC)
        UPDATE public.accounts a
           SET sent_today = CASE WHEN a.sent_day = l.d THEN a.sent_today + l.total ELSE l.total END,
               sent_day = l.d
          FROM latest l
         WHERE a.id = l.account_id AND a.type <> 'SYSTEM'
           AND (a.sent_day IS NULL OR a.sent_day <= l.d);
        RETURN NULL;
      END;
      $$`);
    await queryRunner.query('REVOKE ALL ON FUNCTION public.add_daily_debit() FROM PUBLIC');
    await queryRunner.query(`CREATE TRIGGER ledger_entries_daily_debit_counter
      AFTER INSERT ON public.ledger_entries
      REFERENCING NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION public.add_daily_debit()`);

    await queryRunner.query(`WITH latest AS (
        SELECT DISTINCT ON (e.account_id) e.account_id,
               (e.created_at AT TIME ZONE '${TZ}')::date AS d
        FROM public.ledger_entries e
        JOIN public.accounts a ON a.id = e.account_id AND a.type <> 'SYSTEM'
        WHERE e.direction = 'DEBIT'
        ORDER BY e.account_id, e.created_at DESC),
      totals AS (
        SELECT l.account_id, l.d, sum(e.amount) AS total
        FROM latest l
        JOIN public.ledger_entries e ON e.account_id = l.account_id AND e.direction = 'DEBIT'
         AND e.created_at >= (l.d::timestamp AT TIME ZONE '${TZ}')
         AND e.created_at <  ((l.d + 1)::timestamp AT TIME ZONE '${TZ}')
        GROUP BY l.account_id, l.d)
      UPDATE public.accounts a SET sent_day = t.d, sent_today = t.total
        FROM totals t WHERE a.id = t.account_id`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'");
    await queryRunner.query(
      'DROP TRIGGER ledger_entries_daily_debit_counter ON public.ledger_entries',
    );
    await queryRunner.query('DROP FUNCTION public.add_daily_debit()');
    await queryRunner.query(`ALTER TABLE accounts
      DROP CONSTRAINT accounts_sent_day_when_sent,
      DROP CONSTRAINT accounts_sent_today_non_negative,
      DROP COLUMN sent_day,
      DROP COLUMN sent_today`);
  }
}
