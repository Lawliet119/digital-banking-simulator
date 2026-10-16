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

  // ---- ledger_entries -----------------------------------------------------------------------

  interface EntryRow {
    transferId: string;
    accountId: string;
    direction: string;
    amount: string;
    balanceAfter?: string;
  }

  function insertEntry(row: EntryRow) {
    return attempt<{ id: string; created_at: Date }>(
      runner,
      `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, balance_after)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [row.transferId, row.accountId, row.direction, row.amount, row.balanceAfter ?? '0'],
    );
  }

  /** A COMPLETED 300.000đ transfer a → b with no ledger lines yet. */
  async function completedTransfer(amount = '300000') {
    const { a, b, user } = await twoAccounts();
    const [{ id }] = await insertTransfer({ from: a, to: b, amount, initiatedBy: user });
    return { id, a, b, user, amount };
  }

  const DEBIT_FKEY = 'ledger_entries_transfer_debit_fkey';
  const CREDIT_FKEY = 'ledger_entries_transfer_credit_fkey';

  describe('ledger_entries', () => {
    it('TC-21-11 (ledger_entries) defaults created_at to clock_timestamp(), not the transaction start', async () => {
      const t = await completedTransfer();
      const [{ now }] = await runner.query('SELECT now() AS now');

      await runner.query('SELECT pg_sleep(0.01)');
      const [debit] = await insertEntry({
        transferId: t.id,
        accountId: t.a,
        direction: 'DEBIT',
        amount: t.amount,
      });
      await runner.query('SELECT pg_sleep(0.01)');
      const [credit] = await insertEntry({
        transferId: t.id,
        accountId: t.b,
        direction: 'CREDIT',
        amount: t.amount,
      });

      expect(debit.created_at.getTime()).toBeGreaterThan((now as Date).getTime());
      expect(credit.created_at.getTime()).toBeGreaterThan(debit.created_at.getTime());
    });

    it('TC-21-12 numbers lines with an identity the caller cannot choose', async () => {
      const t = await completedTransfer();

      await expect(
        attempt(
          runner,
          `INSERT INTO ledger_entries (id, transfer_id, account_id, direction, amount, balance_after)
           VALUES (1, $1, $2, 'DEBIT', $3, 0)`,
          [t.id, t.a, t.amount],
        ),
      ).rejects.toMatchObject({ code: '428C9' });

      const [debit] = await insertEntry({
        transferId: t.id,
        accountId: t.a,
        direction: 'DEBIT',
        amount: t.amount,
      });
      const [credit] = await insertEntry({
        transferId: t.id,
        accountId: t.b,
        direction: 'CREDIT',
        amount: t.amount,
      });
      expect(BigInt(credit.id)).toBeGreaterThan(BigInt(debit.id));
    });

    it('TC-21-13 allows one DEBIT and one CREDIT per transfer, no more', async () => {
      const t = await completedTransfer();
      const other = await completedTransfer();
      const debit = { transferId: t.id, accountId: t.a, direction: 'DEBIT', amount: t.amount };
      const credit = { transferId: t.id, accountId: t.b, direction: 'CREDIT', amount: t.amount };

      await insertEntry(debit);
      await expect(insertEntry(debit)).rejects.toMatchObject({
        code: '23505',
        constraint: 'ledger_entries_one_per_direction',
      });
      await insertEntry(credit);
      await expect(insertEntry(credit)).rejects.toMatchObject({
        code: '23505',
        constraint: 'ledger_entries_one_per_direction',
      });
      // Another transfer has its own pair.
      await insertEntry({
        transferId: other.id,
        accountId: other.a,
        direction: 'DEBIT',
        amount: other.amount,
      });
    });

    it('TC-21-14 rejects a non-positive amount, an unknown direction and a missing balance_after', async () => {
      const t = await completedTransfer();
      const line = { transferId: t.id, accountId: t.a, direction: 'DEBIT', amount: t.amount };

      for (const amount of ['0', '-5']) {
        await expect(insertEntry({ ...line, amount })).rejects.toMatchObject({
          code: '23514',
          constraint: 'ledger_entries_amount_check',
        });
      }
      await expect(insertEntry({ ...line, direction: 'debit' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'ledger_entries_direction_check',
      });
      await expect(
        attempt(
          runner,
          `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, balance_after)
           VALUES ($1, $2, 'DEBIT', $3, NULL)`,
          [t.id, t.a, t.amount],
        ),
      ).rejects.toMatchObject({ code: '23502' });

      // A negative balance_after is allowed: the SYSTEM funding account goes negative (ADR-09).
      const [{ id }] = await insertEntry({ ...line, balanceAfter: '-1' });
      const rows = await runner.query('SELECT balance_after FROM ledger_entries WHERE id = $1', [
        id,
      ]);
      expect(rows).toEqual([{ balance_after: '-1' }]);
    });

    it('TC-21-15 rejects a line whose transfer or account does not exist', async () => {
      const t = await completedTransfer();

      // The transfer does not exist (the accounts do).
      await expect(
        insertEntry({ transferId: MISSING, accountId: t.a, direction: 'DEBIT', amount: t.amount }),
      ).rejects.toMatchObject({ code: '23503', constraint: DEBIT_FKEY });
      await expect(
        insertEntry({ transferId: MISSING, accountId: t.b, direction: 'CREDIT', amount: t.amount }),
      ).rejects.toMatchObject({ code: '23503', constraint: CREDIT_FKEY });
      // The account does not exist (the transfer does, and has no line yet).
      await expect(
        insertEntry({ transferId: t.id, accountId: MISSING, direction: 'DEBIT', amount: t.amount }),
      ).rejects.toMatchObject({ code: '23503', constraint: DEBIT_FKEY });
      await expect(
        insertEntry({
          transferId: t.id,
          accountId: MISSING,
          direction: 'CREDIT',
          amount: t.amount,
        }),
      ).rejects.toMatchObject({ code: '23503', constraint: CREDIT_FKEY });
    });

    it('TC-21-27 rejects a line whose amount differs from the transfer, and accepts the matching pair', async () => {
      const t = await completedTransfer('300000');

      await expect(
        insertEntry({ transferId: t.id, accountId: t.b, direction: 'CREDIT', amount: '1' }),
      ).rejects.toMatchObject({ code: '23503', constraint: CREDIT_FKEY });
      await expect(
        insertEntry({ transferId: t.id, accountId: t.a, direction: 'DEBIT', amount: '299999' }),
      ).rejects.toMatchObject({ code: '23503', constraint: DEBIT_FKEY });
      await expect(
        insertEntry({ transferId: t.id, accountId: t.b, direction: 'CREDIT', amount: '300001' }),
      ).rejects.toMatchObject({ code: '23503', constraint: CREDIT_FKEY });

      await insertEntry({ transferId: t.id, accountId: t.a, direction: 'DEBIT', amount: '300000' });
      await insertEntry({
        transferId: t.id,
        accountId: t.b,
        direction: 'CREDIT',
        amount: '300000',
      });
    });

    it('TC-21-28 rejects a line on the wrong account', async () => {
      const t = await completedTransfer();
      const third = await newAccount();

      await expect(
        insertEntry({ transferId: t.id, accountId: t.a, direction: 'CREDIT', amount: t.amount }),
      ).rejects.toMatchObject({ code: '23503', constraint: CREDIT_FKEY }); // CREDIT on the source
      await expect(
        insertEntry({ transferId: t.id, accountId: t.b, direction: 'DEBIT', amount: t.amount }),
      ).rejects.toMatchObject({ code: '23503', constraint: DEBIT_FKEY }); // DEBIT on the target
      await expect(
        insertEntry({ transferId: t.id, accountId: third, direction: 'DEBIT', amount: t.amount }),
      ).rejects.toMatchObject({ code: '23503', constraint: DEBIT_FKEY }); // a third account
    });

    it('TC-21-29 rejects any line for a REJECTED transfer, even with matching amount and accounts', async () => {
      const { a, b, user } = await twoAccounts();
      const [withTarget] = await insertTransfer({
        from: a,
        to: b,
        status: 'REJECTED',
        rejectReason: 'INSUFFICIENT_FUNDS',
        initiatedBy: user,
      });
      const [noTarget] = await insertTransfer({
        from: a,
        to: null,
        status: 'REJECTED',
        rejectReason: 'ACCOUNT_NOT_ACTIVE',
        initiatedBy: user,
      });

      await expect(
        insertEntry({
          transferId: withTarget.id,
          accountId: a,
          direction: 'DEBIT',
          amount: '300000',
        }),
      ).rejects.toMatchObject({ code: '23503', constraint: DEBIT_FKEY });
      await expect(
        insertEntry({
          transferId: withTarget.id,
          accountId: b,
          direction: 'CREDIT',
          amount: '300000',
        }),
      ).rejects.toMatchObject({ code: '23503', constraint: CREDIT_FKEY });
      await expect(
        insertEntry({
          transferId: noTarget.id,
          accountId: a,
          direction: 'DEBIT',
          amount: '300000',
        }),
      ).rejects.toMatchObject({ code: '23503', constraint: DEBIT_FKEY });
    });

    it('TC-21-30 does not (yet) enforce a complete pair or the balance_after value', async () => {
      // Recorded limitation (§2.8, BL-006): a COMPLETED transfer with only its DEBIT line commits,
      // and balance_after is whatever the caller wrote. Whoever adds a deferred constraint trigger
      // turns this test around on purpose.
      const t = await completedTransfer();

      await insertEntry({
        transferId: t.id,
        accountId: t.a,
        direction: 'DEBIT',
        amount: t.amount,
        balanceAfter: '999',
      });

      const rows = await runner.query(
        'SELECT count(*)::int AS count FROM ledger_entries WHERE transfer_id = $1',
        [t.id],
      );
      expect(rows).toEqual([{ count: 1 }]);
    });

    it('TC-21-31 does not let the caller write the generated columns', async () => {
      const t = await completedTransfer();

      for (const [column, value] of [
        ['transfer_status', "'COMPLETED'"],
        ['debit_account', `'${t.a}'`],
        ['credit_account', 'NULL'],
      ]) {
        await expect(
          attempt(
            runner,
            `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, balance_after, ${column})
             VALUES ($1, $2, 'DEBIT', $3, 0, ${value})`,
            [t.id, t.a, t.amount],
          ),
        ).rejects.toMatchObject({ code: '428C9' });
      }
    });

    it('TC-21-26 (ledger_entries) keeps amounts above 2^53 exact and refuses one above the bigint maximum', async () => {
      for (const value of ['9007199254740993', '9223372036854775807']) {
        const t = await completedTransfer(value);
        const [{ id }] = await insertEntry({
          transferId: t.id,
          accountId: t.a,
          direction: 'DEBIT',
          amount: value,
          balanceAfter: value,
        });
        const rows = await runner.query(
          'SELECT amount, balance_after FROM ledger_entries WHERE id = $1',
          [id],
        );
        expect(rows).toEqual([{ amount: value, balance_after: value }]);
      }

      const t = await completedTransfer();
      const line = { transferId: t.id, accountId: t.a, direction: 'DEBIT', amount: t.amount };
      await expect(insertEntry({ ...line, amount: '9223372036854775808' })).rejects.toMatchObject({
        code: '22003',
      });
      await expect(
        insertEntry({ ...line, balanceAfter: '9223372036854775808' }),
      ).rejects.toMatchObject({
        code: '22003',
      });
    });

    describe('indexes serve the queries they were made for (TC-21-22)', () => {
      interface PlanNode {
        'Node Type': string;
        'Index Name'?: string;
        Plans?: PlanNode[];
      }

      /** Plans `sql` with sequential and bitmap scans off, so the planner must pick an index path. */
      async function planNodes(sql: string, params: unknown[]): Promise<PlanNode[]> {
        await runner.query('SET LOCAL enable_seqscan = off');
        await runner.query('SET LOCAL enable_bitmapscan = off');
        const rows = (await runner.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)) as {
          'QUERY PLAN': { Plan: PlanNode }[];
        }[];
        const nodes: PlanNode[] = [];
        const walk = (node: PlanNode) => {
          nodes.push(node);
          node.Plans?.forEach(walk);
        };
        walk(rows[0]['QUERY PLAN'][0].Plan);
        return nodes;
      }

      it('TC-21-22 the daily limit uses an index-only scan, the history page an ordered index scan', async () => {
        const account = await newAccount();

        const daily = await planNodes(
          `SELECT coalesce(sum(amount), 0) FROM ledger_entries
            WHERE account_id = $1 AND direction = 'DEBIT' AND created_at >= $2`,
          [account, '2026-10-17T00:00:00+07:00'],
        );
        expect(daily).toContainEqual(
          expect.objectContaining({
            'Node Type': 'Index Only Scan',
            'Index Name': 'ledger_entries_daily_debit_idx',
          }),
        );

        const history = await planNodes(
          `SELECT id, transfer_id, direction, amount, balance_after, created_at FROM ledger_entries
            WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`,
          [account],
        );
        expect(history).toContainEqual(
          expect.objectContaining({
            'Node Type': 'Index Scan',
            'Index Name': 'ledger_entries_account_history_idx',
          }),
        );
        expect(history.map(n => n['Node Type'])).not.toContain('Sort');
      });
    });
  });

  // ---- idempotency_keys ---------------------------------------------------------------------

  const HASH = 'a'.repeat(64); // sha256 in hex is 64 characters

  function insertKey(row: {
    userId: string;
    key: string;
    hash?: string | null;
    transferId?: string | null;
  }) {
    return attempt<{ request_hash: string }>(
      runner,
      `INSERT INTO idempotency_keys (user_id, idem_key, request_hash, transfer_id)
       VALUES ($1, $2, $3, $4) RETURNING request_hash`,
      [row.userId, row.key, row.hash === undefined ? HASH : row.hash, row.transferId ?? null],
    );
  }

  describe('idempotency_keys', () => {
    it('TC-21-16 is unique per user and key, and two users may use the same key', async () => {
      const u = await newUser();
      const v = await newUser();

      await insertKey({ userId: u, key: 'k1' });
      await expect(insertKey({ userId: u, key: 'k1' })).rejects.toMatchObject({
        code: '23505',
        constraint: 'idempotency_keys_pkey',
      });
      // Another user's identical key is a different row: it never sees the first user's response.
      await insertKey({ userId: v, key: 'k1' });
    });

    it('TC-21-17 limits the key to 1–128 characters, counting characters and not bytes', async () => {
      const u = await newUser();

      for (const key of ['', 'a'.repeat(129)]) {
        await expect(insertKey({ userId: u, key })).rejects.toMatchObject({
          code: '23514',
          constraint: 'idempotency_keys_idem_key_check',
        });
      }
      // Boundaries, and 128 two-byte characters (256 bytes).
      for (const key of ['x', 'a'.repeat(128), 'đ'.repeat(128)]) {
        await insertKey({ userId: u, key });
      }
    });

    it('TC-21-18 holds a 64-character request_hash, and a row reserved before its response is known', async () => {
      const u = await newUser();

      await insertKey({ userId: u, key: 'full', hash: HASH });
      await expect(insertKey({ userId: u, key: 'long', hash: HASH + 'b' })).rejects.toMatchObject({
        code: '22001',
      });
      await expect(insertKey({ userId: u, key: 'none', hash: null })).rejects.toMatchObject({
        code: '23502',
      });

      // char(n) quirks, recorded so nobody relies on the database to check the hash shape:
      // trailing spaces beyond 64 are cut, and a short value is padded with spaces to 64.
      await insertKey({ userId: u, key: 'trailing-space', hash: HASH + ' ' });
      const [padded] = await insertKey({ userId: u, key: 'short', hash: 'ab' });
      expect(padded.request_hash).toHaveLength(64);

      // The reservation row: transfer_id, response_code and response_body are still NULL.
      const rows = await runner.query(
        `SELECT transfer_id, response_code, response_body FROM idempotency_keys
          WHERE user_id = $1 AND idem_key = 'full'`,
        [u],
      );
      expect(rows).toEqual([{ transfer_id: null, response_code: null, response_body: null }]);
    });

    it('TC-21-19 rejects a user or a transfer that does not exist', async () => {
      const u = await newUser();

      await expect(insertKey({ userId: MISSING, key: 'k' })).rejects.toMatchObject({
        code: '23503',
        constraint: 'idempotency_keys_user_id_fkey',
      });
      await expect(insertKey({ userId: u, key: 'k', transferId: MISSING })).rejects.toMatchObject({
        code: '23503',
        constraint: 'idempotency_keys_transfer_id_fkey',
      });
    });
  });
});
