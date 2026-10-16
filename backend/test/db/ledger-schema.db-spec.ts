import { randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';
import { REJECT_REASONS } from '@common/errors/reject-reason';
import { attempt, createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

// DBS-21: the database itself protects the money-flow invariants (database-design §4.3–4.5, §5,
// §8.2). Every rejection is asserted by SQLSTATE and constraint name, never by message text. Each
// bad row breaks exactly one constraint: PostgreSQL checks CHECK constraints in name order, and
// CHECK runs before UNIQUE, which runs before foreign keys.
//
// Rows in `transfers` and `ledger_entries` are seed SQL used only to probe constraints, in a
// transaction that is rolled back. There is no deposit API yet, and nothing here touches
// `accounts.balance`.

const FUNDING_ID = '00000000-0000-4000-8000-000000000001';
const MISSING = '11111111-1111-4111-8111-111111111111';

describe('migration 2: transfers, ledger_entries, idempotency_keys', () => {
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

  // ---- fixtures -----------------------------------------------------------------------------

  async function newUser(): Promise<string> {
    const rows = await attempt<{ id: string }>(
      runner,
      'INSERT INTO users (cognito_sub) VALUES ($1) RETURNING id',
      [`sub-${randomUUID()}`],
    );
    return rows[0].id;
  }

  /** A customer's CHECKING account (a customer with their own user). */
  async function newAccount(): Promise<string> {
    const userId = await newUser();
    const customer = await attempt<{ id: string }>(
      runner,
      'INSERT INTO customers (user_id, full_name) VALUES ($1, $2) RETURNING id',
      [userId, 'Nguyễn Văn An'],
    );
    const account = await attempt<{ id: string }>(
      runner,
      `INSERT INTO accounts (customer_id, type) VALUES ($1, 'CHECKING') RETURNING id`,
      [customer[0].id],
    );
    return account[0].id;
  }

  interface TransferRow {
    type: string;
    from: string;
    to: string | null;
    amount: string;
    status: string;
    rejectReason: string | null;
    initiatedBy: string;
  }

  async function insertTransfer(
    row: Partial<TransferRow> & { from: string; initiatedBy: string },
  ): Promise<{ id: string; created_at: Date }[]> {
    const r = {
      type: 'TRANSFER',
      to: null,
      amount: '300000',
      status: 'COMPLETED',
      rejectReason: null,
      ...row,
    };
    return attempt<{ id: string; created_at: Date }>(
      runner,
      `INSERT INTO transfers
         (type, from_account_id, to_account_id, amount, status, reject_reason, initiated_by, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
      [r.type, r.from, r.to, r.amount, r.status, r.rejectReason, r.initiatedBy, randomUUID()],
    );
  }

  /** Two customer accounts and the user that initiates a transfer between them. */
  async function twoAccounts() {
    return { a: await newAccount(), b: await newAccount(), user: await newUser() };
  }

  // ---- transfers ----------------------------------------------------------------------------

  describe('transfers', () => {
    it('TC-21-03 accepts completed transfers and deposits, and rejected orders with or without a target', async () => {
      const { a, b, user } = await twoAccounts();

      await insertTransfer({ from: a, to: b, initiatedBy: user });
      await insertTransfer({ type: 'DEPOSIT', from: FUNDING_ID, to: b, initiatedBy: user });
      await insertTransfer({ from: a, to: b, amount: '1', initiatedBy: user }); // boundary
      for (const reason of REJECT_REASONS) {
        await insertTransfer({
          from: a,
          to: null, // the destination does not exist (UC-5 6a)
          status: 'REJECTED',
          rejectReason: reason,
          initiatedBy: user,
        });
      }
      // Recorded limitation (G1 question 6): the rule "no target only for ACCOUNT_NOT_ACTIVE" is the
      // transfer service's job; the three approved CHECKs let this row through.
      await insertTransfer({
        from: a,
        to: null,
        status: 'REJECTED',
        rejectReason: 'INSUFFICIENT_FUNDS',
        initiatedBy: user,
      });

      const [{ count }] = await runner.query('SELECT count(*)::int AS count FROM transfers');
      expect(count).toBe(3 + REJECT_REASONS.length + 1);
    });

    it('TC-21-04 rejects an unknown type, status or reject_reason', async () => {
      const { a, b, user } = await twoAccounts();

      for (const type of ['WITHDRAWAL', 'transfer']) {
        await expect(
          insertTransfer({ type, from: a, to: b, initiatedBy: user }),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'transfers_type_check',
        });
      }
      await expect(
        insertTransfer({ status: 'PENDING', from: a, to: b, initiatedBy: user }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'transfers_status_check' });
      await expect(
        insertTransfer({
          status: 'REJECTED',
          rejectReason: 'FRAUD',
          from: a,
          to: b,
          initiatedBy: user,
        }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'transfers_reject_reason_check' });
    });

    it('TC-21-05 rejects an amount of 0 or less', async () => {
      const { a, b, user } = await twoAccounts();

      for (const amount of ['0', '-1']) {
        await expect(
          insertTransfer({ amount, from: a, to: b, initiatedBy: user }),
        ).rejects.toMatchObject({ code: '23514', constraint: 'transfers_amount_check' });
      }
    });

    it('TC-21-06 rejects a transfer from an account to itself', async () => {
      const { a, user } = await twoAccounts();

      await expect(insertTransfer({ from: a, to: a, initiatedBy: user })).rejects.toMatchObject({
        code: '23514',
        constraint: 'transfers_distinct_accounts',
      });
      await expect(
        insertTransfer({
          from: a,
          to: a,
          status: 'REJECTED',
          rejectReason: 'INSUFFICIENT_FUNDS',
          initiatedBy: user,
        }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'transfers_distinct_accounts' });
    });

    it('TC-21-07 rejects a REJECTED order without a reason and a COMPLETED one with a reason', async () => {
      const { a, b, user } = await twoAccounts();

      await expect(
        insertTransfer({ status: 'REJECTED', from: a, to: b, initiatedBy: user }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'transfers_reason_matches_status' });
      await expect(
        insertTransfer({ rejectReason: 'INSUFFICIENT_FUNDS', from: a, to: b, initiatedBy: user }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'transfers_reason_matches_status' });
    });

    it('TC-21-08 rejects a COMPLETED transfer without a target account', async () => {
      const { a, user } = await twoAccounts();

      await expect(insertTransfer({ from: a, to: null, initiatedBy: user })).rejects.toMatchObject({
        code: '23514',
        constraint: 'transfers_completed_has_target',
      });
    });

    it('TC-21-09 rejects references to accounts or a user that do not exist', async () => {
      const { a, b, user } = await twoAccounts();

      await expect(
        insertTransfer({ from: MISSING, to: b, initiatedBy: user }),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'transfers_from_account_id_fkey',
      });
      await expect(
        insertTransfer({ from: a, to: MISSING, initiatedBy: user }),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'transfers_to_account_id_fkey',
      });
      await expect(insertTransfer({ from: a, to: b, initiatedBy: MISSING })).rejects.toMatchObject({
        code: '23503',
        constraint: 'transfers_initiated_by_fkey',
      });
    });

    it('TC-21-11 (transfers) defaults created_at to clock_timestamp(), not the transaction start', async () => {
      const { a, b, user } = await twoAccounts();
      const [{ now }] = await runner.query('SELECT now() AS now');

      await runner.query('SELECT pg_sleep(0.01)');
      const [first] = await insertTransfer({ from: a, to: b, initiatedBy: user });
      await runner.query('SELECT pg_sleep(0.01)');
      const [second] = await insertTransfer({ from: a, to: b, initiatedBy: user });

      // now() would give both rows the transaction's start time.
      expect(first.created_at.getTime()).toBeGreaterThan((now as Date).getTime());
      expect(second.created_at.getTime()).toBeGreaterThan(first.created_at.getTime());
    });

    it('TC-21-26 (transfers) keeps an amount above 2^53 exact and refuses one above the bigint maximum', async () => {
      const { a, b, user } = await twoAccounts();

      for (const amount of ['9007199254740993', '9223372036854775807']) {
        await insertTransfer({ amount, from: a, to: b, initiatedBy: user });
        const rows = await runner.query(
          'SELECT amount FROM transfers WHERE from_account_id = $1 AND amount = $2',
          [a, amount],
        );
        expect(rows).toEqual([{ amount }]);
      }
      await expect(
        insertTransfer({ amount: '9223372036854775808', from: a, to: b, initiatedBy: user }),
      ).rejects.toMatchObject({ code: '22003' });
    });

    it('TC-21-25 keeps transfers.reject_reason in step with REJECT_REASONS', async () => {
      const rows = await runner.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'transfers'::regclass AND conname = 'transfers_reject_reason_check'`,
      );
      const inDatabase = [...(rows[0].def as string).matchAll(/'([A-Z_]+)'::text/g)]
        .map(m => m[1])
        .sort();

      expect(inDatabase).toEqual([...REJECT_REASONS].sort());
    });
  });
});
