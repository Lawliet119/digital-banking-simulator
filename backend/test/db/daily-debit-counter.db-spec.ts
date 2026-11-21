import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';
import {
  attempt,
  createTempDatabase,
  migrate,
  migrateThrough,
  type TempDatabase,
} from '../support/temp-database';
import {
  INVARIANT_FUNDING_ID,
  postInvariantTransfer,
  seedInvariantAccounts,
  type InvariantAccounts,
} from '../support/invariant-fixtures';
import { checkLedgerInvariants } from '../support/invariants';

/**
 * BL-418. The day total of the daily limit (BR-06) is kept on the account row by a statement-level
 * trigger on ledger_entries, instead of a SUM taken while the row locks are held.
 *
 * Schema, trigger, backfill and migration locking. The guard that reads the counter is in
 * `sync-guard.db-spec.ts`; the concurrent flows are in `daily-debit-counter-flow.db-spec.ts`.
 */
const PREVIOUS = 'TuneTransfersAutovacuum1795000011000';
const VN = 'Asia/Ho_Chi_Minh';

const sqlstate = (error: unknown): string | undefined => {
  const e = error as { code?: string; driverError?: { code?: string }; cause?: { code?: string } };
  return e?.driverError?.code ?? e?.code ?? e?.cause?.code;
};

interface Counter {
  sentToday: string;
  sentDay: string | null;
}
async function counterOf(runner: Pick<QueryRunner, 'query'>, id: string): Promise<Counter> {
  const [row] = (await runner.query(
    `SELECT sent_today::text AS "sentToday", to_char(sent_day,'YYYY-MM-DD') AS "sentDay"
     FROM accounts WHERE id=$1`,
    [id],
  )) as Counter[];
  return row;
}
/** The truth the counter must equal: the latest Vietnam day with a DEBIT line, and that day's sum. */
async function ledgerTruth(runner: Pick<QueryRunner, 'query'>, id: string): Promise<Counter> {
  const [row] = (await runner.query(
    `WITH last AS (
       SELECT max((created_at AT TIME ZONE '${VN}')::date) AS d
       FROM ledger_entries WHERE account_id=$1 AND direction='DEBIT')
     SELECT to_char(last.d,'YYYY-MM-DD') AS "sentDay",
            coalesce((SELECT sum(amount) FROM ledger_entries e
                       WHERE e.account_id=$1 AND e.direction='DEBIT'
                         AND (e.created_at AT TIME ZONE '${VN}')::date = last.d),0)::text AS "sentToday"
     FROM last`,
    [id],
  )) as Counter[];
  return row;
}

/** SQL INPUT: a COMPLETED transfer and its DEBIT line at an exact instant (the ledger is append-only). */
async function debitAt(
  runner: Pick<QueryRunner, 'query'>,
  input: { actorId: string; from: string; to: string; amount: string; at: string },
): Promise<void> {
  const [transfer] = await runner.query(
    `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id,created_at)
     VALUES('TRANSFER',$1,$2,$3,'COMPLETED',$4,$5,$6::timestamptz) RETURNING id`,
    [input.from, input.to, input.amount, input.actorId, randomUUID(), input.at],
  );
  await runner.query(
    `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after,created_at)
     VALUES($1,$2,'DEBIT',$3,0,$4::timestamptz)`,
    [transfer.id, input.from, input.amount, input.at],
  );
}

describe('BL-418 the daily debit counter on accounts (schema, trigger, backfill, migration)', () => {
  describe('on the final schema', () => {
    let db: TempDatabase, refs: InvariantAccounts;
    const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

    beforeAll(async () => {
      db = await createTempDatabase();
      await migrate(db.url);
      await db.runner.startTransaction();
      refs = await seedInvariantAccounts(db.runner);
      await db.runner.commitTransaction();
    });
    afterAll(async () => {
      await db?.drop();
    });

    it('TC-418-01 adds the two columns, two named CHECKs, a SECURITY DEFINER function and a statement trigger', async () => {
      const columns = await q(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_name='accounts' AND column_name IN ('sent_today','sent_day') ORDER BY column_name`,
      );
      expect(columns).toEqual([
        { column_name: 'sent_day', data_type: 'date', is_nullable: 'YES', column_default: null },
        { column_name: 'sent_today', data_type: 'bigint', is_nullable: 'NO', column_default: '0' },
      ]);
      await db.runner.startTransaction();
      try {
        await expect(
          attempt(
            db.runner,
            'UPDATE accounts SET sent_today=-1, sent_day=current_date WHERE id=$1',
            [refs.senderId],
          ),
        ).rejects.toMatchObject({
          driverError: { code: '23514', constraint: 'accounts_sent_today_non_negative' },
        });
        await expect(
          attempt(db.runner, 'UPDATE accounts SET sent_today=5, sent_day=NULL WHERE id=$1', [
            refs.senderId,
          ]),
        ).rejects.toMatchObject({
          driverError: { code: '23514', constraint: 'accounts_sent_day_when_sent' },
        });
      } finally {
        await db.runner.rollbackTransaction();
      }
      const [fn] = await q(
        `SELECT prosecdef, proconfig::text AS config, coalesce(proacl::text,'') AS acl
         FROM pg_proc WHERE proname='add_daily_debit' AND pronamespace='public'::regnamespace`,
      );
      expect(fn.prosecdef).toBe(true);
      expect(fn.config).toContain('search_path=pg_catalog, pg_temp');
      // PUBLIC is the empty grantee: "=X/owner". An ACL that does not exist at all would mean the default.
      expect(fn.acl).not.toBe('');
      expect(fn.acl).not.toMatch(/(^|[{,])=X\//);
      const [trigger] = await q(
        `SELECT tgname, (tgtype & 1) = 1 AS per_row, (tgtype & 4) = 4 AS on_insert,
                tgnewtable AS new_table, tgenabled
         FROM pg_trigger WHERE tgrelid='ledger_entries'::regclass AND NOT tgisinternal
           AND tgname='ledger_entries_daily_debit_counter'`,
      );
      expect(trigger).toEqual({
        tgname: 'ledger_entries_daily_debit_counter',
        per_row: false,
        on_insert: true,
        new_table: 'new_rows',
        tgenabled: 'O',
      });
    });

    it('TC-418-02 adds up inside a Vietnam day, resets after 00:00, never goes back, ignores credits and SYSTEM', async () => {
      const a = refs.senderId,
        b = refs.recipientId;
      await db.runner.startTransaction();
      await debitAt(db.runner, {
        actorId: refs.actorId,
        from: a,
        to: b,
        amount: '1000',
        at: '2026-03-10T02:00:00Z',
      });
      await debitAt(db.runner, {
        actorId: refs.actorId,
        from: a,
        to: b,
        amount: '2500',
        at: '2026-03-10T10:00:00Z',
      });
      await db.runner.commitTransaction();
      expect(await counterOf(db.runner, a)).toEqual({ sentToday: '3500', sentDay: '2026-03-10' });
      // 16:59:59Z is 23:59:59 in Vietnam: still the 10th. 17:00:00Z is 00:00 on the 11th.
      await debitAt(db.runner, {
        actorId: refs.actorId,
        from: a,
        to: b,
        amount: '700',
        at: '2026-03-10T16:59:59Z',
      });
      expect(await counterOf(db.runner, a)).toEqual({ sentToday: '4200', sentDay: '2026-03-10' });
      await debitAt(db.runner, {
        actorId: refs.actorId,
        from: a,
        to: b,
        amount: '900',
        at: '2026-03-10T17:00:00Z',
      });
      expect(await counterOf(db.runner, a)).toEqual({ sentToday: '900', sentDay: '2026-03-11' });
      // A line dated before the counter's day never moves the counter back (seed, test, a late writer).
      await debitAt(db.runner, {
        actorId: refs.actorId,
        from: a,
        to: b,
        amount: '123',
        at: '2026-03-09T05:00:00Z',
      });
      expect(await counterOf(db.runner, a)).toEqual({ sentToday: '900', sentDay: '2026-03-11' });
      expect(await counterOf(db.runner, a)).toEqual(await ledgerTruth(db.runner, a));
      // The credit side of the same transfers and the SYSTEM funding account are not counted.
      expect(await counterOf(db.runner, b)).toEqual({ sentToday: '0', sentDay: null });
      await db.runner.startTransaction();
      await postInvariantTransfer(db.runner, {
        actorId: refs.actorId,
        from: INVARIANT_FUNDING_ID,
        to: b,
        amount: '5000',
        type: 'DEPOSIT',
      });
      await db.runner.commitTransaction();
      expect(await counterOf(db.runner, INVARIANT_FUNDING_ID)).toEqual({
        sentToday: '0',
        sentDay: null,
      });
    });

    it('TC-418-02 one INSERT of many lines over many days updates the account row once, to the latest day only', async () => {
      const [user] = await q(
        `INSERT INTO users(cognito_sub) VALUES('bulk-' || gen_random_uuid()) RETURNING id`,
      );
      const [customer] = await q(
        `INSERT INTO customers(user_id,full_name) VALUES($1,'Phạm Hùng') RETURNING id`,
        [user.id],
      );
      const [account] = await q(
        `INSERT INTO accounts(customer_id,type) VALUES($1,'CHECKING') RETURNING id`,
        [customer.id],
      );
      await db.runner.startTransaction();
      try {
        await q(
          `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id,created_at)
           SELECT 'TRANSFER',$1::uuid,$2::uuid,1000,'COMPLETED',$3::uuid,gen_random_uuid(),
                  '2026-04-01T05:00:00Z'::timestamptz + (g % 3) * interval '1 day' + g * interval '1 second'
           FROM generate_series(1,300) g`,
          [account.id, refs.recipientId, refs.actorId],
        );
        const [{ before }] = await q(
          `SELECT n_tup_upd::int AS before FROM pg_stat_xact_user_tables WHERE relname='accounts'`,
        );
        await q(
          `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after,created_at)
           SELECT id,from_account_id,'DEBIT',amount,0,created_at FROM transfers WHERE from_account_id=$1`,
          [account.id],
        );
        const [{ after }] = await q(
          `SELECT n_tup_upd::int AS after FROM pg_stat_xact_user_tables WHERE relname='accounts'`,
        );
        // 300 lines on three days, 100 each: only the latest day, 100 x 1000, and one UPDATE.
        expect(await counterOf(db.runner, account.id)).toEqual({
          sentToday: '100000',
          sentDay: '2026-04-03',
        });
        expect(after - before).toBe(1);
        expect(await counterOf(db.runner, account.id)).toEqual(
          await ledgerTruth(db.runner, account.id),
        );
      } finally {
        await db.runner.rollbackTransaction();
      }
    });

    it('TC-418-02 two writers that hold no lock first lose no addition (one atomic UPDATE under READ COMMITTED)', async () => {
      const other = await new DataSource({ type: 'postgres', url: db.url }).initialize();
      const second = other.createQueryRunner();
      await second.connect();
      const [user] = await q(
        `INSERT INTO users(cognito_sub) VALUES('race-' || gen_random_uuid()) RETURNING id`,
      );
      const [customer] = await q(
        `INSERT INTO customers(user_id,full_name) VALUES($1,'Võ Thị Mai') RETURNING id`,
        [user.id],
      );
      const [account] = await q(
        `INSERT INTO accounts(customer_id,type) VALUES($1,'CHECKING') RETURNING id`,
        [customer.id],
      );
      const at = '2026-05-05T03:00:00Z';
      try {
        await db.runner.startTransaction();
        await second.startTransaction();
        await debitAt(db.runner, {
          actorId: refs.actorId,
          from: account.id,
          to: refs.recipientId,
          amount: '400',
          at,
        });
        // The second writer reaches the same account row while the first still holds it.
        const pending = debitAt(second, {
          actorId: refs.actorId,
          from: account.id,
          to: refs.recipientId,
          amount: '600',
          at,
        });
        for (let i = 0; i < 100; i++) {
          const [{ waiting }] = await q(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity
             WHERE datname=current_database() AND wait_event_type='Lock'`,
          );
          if (waiting > 0) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        await db.runner.commitTransaction();
        await pending;
        await second.commitTransaction();
        expect(await counterOf(db.runner, account.id)).toEqual({
          sentToday: '1000',
          sentDay: '2026-05-05',
        });
        expect(await counterOf(db.runner, account.id)).toEqual(
          await ledgerTruth(db.runner, account.id),
        );
      } finally {
        await second.release();
        await other.destroy();
      }
    });

    it('TC-418-02 an amount above 2^53 survives the counter digit for digit', async () => {
      const [user] = await q(
        `INSERT INTO users(cognito_sub) VALUES('big-' || gen_random_uuid()) RETURNING id`,
      );
      const [customer] = await q(
        `INSERT INTO customers(user_id,full_name) VALUES($1,'Đỗ Quang Huy') RETURNING id`,
        [user.id],
      );
      const [account] = await q(
        `INSERT INTO accounts(customer_id,type) VALUES($1,'CHECKING') RETURNING id`,
        [customer.id],
      );
      await debitAt(db.runner, {
        actorId: refs.actorId,
        from: account.id,
        to: refs.recipientId,
        amount: '9007199254740993',
        at: '2026-06-01T03:00:00Z',
      });
      expect(await counterOf(db.runner, account.id)).toEqual({
        sentToday: '9007199254740993',
        sentDay: '2026-06-01',
      });
    });
  });

  it('TC-418-03 the migration backfills every account from the ledger that already exists', async () => {
    const db = await createTempDatabase();
    try {
      await migrateThrough(db.url, PREVIOUS);
      await db.runner.startTransaction();
      const refs = await seedInvariantAccounts(db.runner);
      await db.runner.commitTransaction();
      const { senderId: a, recipientId: b, unusedId: c } = refs;
      const base = { actorId: refs.actorId, to: b };
      // A: two days, the latest has two lines. B (credit side only) and C: nothing. Funding: a debit, SYSTEM.
      await debitAt(db.runner, { ...base, from: a, amount: '111', at: '2026-02-01T05:00:00Z' });
      await debitAt(db.runner, { ...base, from: a, amount: '1000', at: '2026-02-02T05:00:00Z' });
      await debitAt(db.runner, { ...base, from: a, amount: '2000', at: '2026-02-02T16:59:59Z' });
      await debitAt(db.runner, {
        ...base,
        from: INVARIANT_FUNDING_ID,
        amount: '9999',
        at: '2026-02-02T06:00:00Z',
      });
      // A line at 17:00:00Z is already the next Vietnam day: it alone is the latest day of D.
      const [user] = await db.runner.query(
        `INSERT INTO users(cognito_sub) VALUES('d-user') RETURNING id`,
      );
      const [customer] = await db.runner.query(
        `INSERT INTO customers(user_id,full_name) VALUES($1,'Bùi Thu Hà') RETURNING id`,
        [user.id],
      );
      const [d] = await db.runner.query(
        `INSERT INTO accounts(customer_id,type) VALUES($1,'CHECKING') RETURNING id`,
        [customer.id],
      );
      await debitAt(db.runner, { ...base, from: d.id, amount: '50', at: '2026-02-02T16:59:59Z' });
      await debitAt(db.runner, { ...base, from: d.id, amount: '70', at: '2026-02-02T17:00:00Z' });

      await migrate(db.url);

      expect(await counterOf(db.runner, a)).toEqual({ sentToday: '3000', sentDay: '2026-02-02' });
      expect(await counterOf(db.runner, d.id)).toEqual({ sentToday: '70', sentDay: '2026-02-03' });
      for (const id of [b, c, INVARIANT_FUNDING_ID]) {
        expect(await counterOf(db.runner, id)).toEqual({ sentToday: '0', sentDay: null });
      }
      for (const id of [a, d.id]) {
        expect(await counterOf(db.runner, id)).toEqual(await ledgerTruth(db.runner, id));
      }
      // revert drops everything it added, run adds it back, and the counter is rebuilt from the ledger
      await migrate(db.url, 'undoLast');
      const dropped = await db.runner.query(
        `SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name='accounts' AND column_name IN ('sent_today','sent_day'))::int AS columns,
                (SELECT count(*) FROM pg_proc WHERE proname='add_daily_debit')::int AS functions,
                (SELECT count(*) FROM pg_trigger WHERE tgname='ledger_entries_daily_debit_counter')::int AS triggers`,
      );
      expect(dropped).toEqual([{ columns: 0, functions: 0, triggers: 0 }]);
      await migrate(db.url);
      expect(await counterOf(db.runner, a)).toEqual({ sentToday: '3000', sentDay: '2026-02-02' });
    } finally {
      await db.drop();
    }
  });

  describe('TC-418-15 the migration against a transfer that is still in flight', () => {
    let db: TempDatabase, refs: InvariantAccounts, blocker: DataSource, held: QueryRunner;

    beforeEach(async () => {
      db = await createTempDatabase();
      await migrateThrough(db.url, PREVIOUS);
      await db.runner.startTransaction();
      refs = await seedInvariantAccounts(db.runner);
      await postInvariantTransfer(db.runner, {
        actorId: refs.actorId,
        from: INVARIANT_FUNDING_ID,
        to: refs.senderId,
        amount: '1000000',
        type: 'DEPOSIT',
      });
      await db.runner.commitTransaction();
      blocker = await new DataSource({ type: 'postgres', url: db.url }).initialize();
      held = blocker.createQueryRunner();
      await held.connect();
      await held.startTransaction();
      // What a transfer does first: lock the source account row.
      await held.query('SELECT id FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
        [refs.senderId, refs.recipientId],
      ]);
    });
    afterEach(async () => {
      if (held.isTransactionActive) await held.rollbackTransaction();
      await held.release();
      await blocker.destroy();
      await db.drop();
    });

    const columnCount = async () =>
      Number(
        (
          await db.runner.query(
            `SELECT count(*)::int AS n FROM information_schema.columns
             WHERE table_name='accounts' AND column_name IN ('sent_today','sent_day')`,
          )
        )[0].n,
      );

    it('(a) gives up after lock_timeout (55P03) and changes nothing while the transfer never ends', async () => {
      const started = Date.now();
      const failure = await migrate(db.url).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(sqlstate(failure)).toBe('55P03');
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(await columnCount()).toBe(0);
      await held.rollbackTransaction();
      await migrate(db.url);
      expect(await columnCount()).toBe(2);
    }, 60_000);

    it('(b) waits for the transfer, does not deadlock, and counts the lines it wrote while the migration queued', async () => {
      const migration = migrate(db.url);
      // The ALTER is really waiting for the row lock held by the transfer.
      let queued = false;
      for (let i = 0; i < 60 && !queued; i++) {
        const [{ n }] = await db.runner.query(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
           WHERE c.relname='accounts' AND l.mode='AccessExclusiveLock' AND NOT l.granted`,
        );
        queued = n > 0;
        if (!queued) await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(queued).toBe(true);
      // The transfer carries on and writes its ledger lines before it commits (it is not blocked
      // by the queued ALTER because it already holds a lock on the table).
      await postInvariantTransfer(held, {
        actorId: refs.actorId,
        from: refs.senderId,
        to: refs.recipientId,
        amount: '250000',
      });
      await held.commitTransaction();
      await migration;
      expect(await counterOf(db.runner, refs.senderId)).toEqual(
        await ledgerTruth(db.runner, refs.senderId),
      );
      expect((await counterOf(db.runner, refs.senderId)).sentToday).toBe('250000');
      const report = await checkLedgerInvariants(db.runner);
      expect(report.violations).toEqual([]);
      expect(report.status).toBe('PASS');
    }, 60_000);
  });
});
