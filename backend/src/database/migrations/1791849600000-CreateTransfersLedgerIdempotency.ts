import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 2 (database-design §4.3–4.5, §6.1, §8.2): the money-flow tables `transfers`,
 * `ledger_entries`, `idempotency_keys` and the read-only view `v_transfer_facts`.
 *
 * Constraint names are spelled out so tests and error handling can rely on them. Foreign keys are
 * RESTRICT on purpose: a bank does not delete history in cascade (database-design rule 8).
 */
export class CreateTransfersLedgerIdempotency1791849600000 implements MigrationInterface {
  name = 'CreateTransfersLedgerIdempotency1791849600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `to_account_id` is nullable: an order to an account that does not exist is still stored,
    // as REJECTED/ACCOUNT_NOT_ACTIVE (UC-5 step 6a), and a foreign key to a missing id would fail.
    // `created_at` is clock_timestamp(): now() is the start of the transaction, which is older than
    // the write when the transfer waited for a hot-account lock.
    await queryRunner.query(`
      CREATE TABLE transfers (
        id              uuid        NOT NULL DEFAULT gen_random_uuid(),
        type            text        NOT NULL,
        from_account_id uuid        NOT NULL,
        to_account_id   uuid,
        amount          bigint      NOT NULL,
        status          text        NOT NULL,
        reject_reason   text,
        initiated_by    uuid        NOT NULL,
        correlation_id  uuid        NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT transfers_pkey PRIMARY KEY (id),
        CONSTRAINT transfers_from_account_id_fkey FOREIGN KEY (from_account_id)
          REFERENCES accounts (id) ON DELETE RESTRICT,
        CONSTRAINT transfers_to_account_id_fkey FOREIGN KEY (to_account_id)
          REFERENCES accounts (id) ON DELETE RESTRICT,
        CONSTRAINT transfers_initiated_by_fkey FOREIGN KEY (initiated_by)
          REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT transfers_type_check CHECK (type IN ('TRANSFER', 'DEPOSIT')),
        CONSTRAINT transfers_amount_check CHECK (amount > 0),
        CONSTRAINT transfers_status_check CHECK (status IN ('COMPLETED', 'REJECTED')),
        CONSTRAINT transfers_reject_reason_check CHECK (reject_reason IN
          ('ACCOUNT_NOT_ACTIVE', 'LIMIT_PER_TX_EXCEEDED', 'LIMIT_PER_DAY_EXCEEDED', 'INSUFFICIENT_FUNDS')),
        CONSTRAINT transfers_distinct_accounts
          CHECK (to_account_id IS NULL OR from_account_id <> to_account_id),
        CONSTRAINT transfers_reason_matches_status
          CHECK ((status = 'REJECTED') = (reject_reason IS NOT NULL)),
        CONSTRAINT transfers_completed_has_target
          CHECK (status <> 'COMPLETED' OR to_account_id IS NOT NULL),
        -- Targets of the composite foreign keys from ledger_entries (below, in a later step): a
        -- ledger line can then only exist with the transfer's own amount, on the transfer's own
        -- account, and only for a COMPLETED transfer. transfers is append-only, so none of these
        -- columns changes after the row is written.
        CONSTRAINT transfers_ledger_from_key UNIQUE (id, amount, status, from_account_id),
        CONSTRAINT transfers_ledger_to_key UNIQUE (id, amount, status, to_account_id)
      )`);

    // R1/R2/R5: count, median amount and new recipient of a sender's recent transfers.
    await queryRunner.query(`
      CREATE INDEX transfers_account_completed_idx ON transfers (from_account_id, created_at)
        INCLUDE (amount, to_account_id)
        WHERE status = 'COMPLETED' AND type = 'TRANSFER'`);
    // R4: a transfer back to the sender within the hour, looked up by the pair of accounts.
    await queryRunner.query(`
      CREATE INDEX transfers_pair_completed_idx ON transfers (from_account_id, to_account_id, created_at)
        WHERE status = 'COMPLETED' AND type = 'TRANSFER'`);

    // Double entry: one DEBIT and one CREDIT per transfer at most (the UNIQUE), each with the
    // transfer's own amount, on the transfer's own account, and only for a COMPLETED transfer
    // (the two composite foreign keys). A DEBIT row points at transfers.from_account_id and a
    // CREDIT row at transfers.to_account_id: of debit_account and credit_account exactly one is
    // non-NULL, and with MATCH SIMPLE a NULL column switches that key off, so one lookup per row.
    // The keys also cover "the transfer exists" and "the account exists" (a transfer's accounts are
    // foreign keys to accounts), so there is no separate foreign key on transfer_id or account_id.
    // "Exactly two lines per COMPLETED transfer" and balance_after are not enforced here; code and
    // the reconciliation job keep them (docs/features/DBS-21 §2.8).
    await queryRunner.query(`
      CREATE TABLE ledger_entries (
        id             bigint      GENERATED ALWAYS AS IDENTITY,
        transfer_id    uuid        NOT NULL,
        account_id     uuid        NOT NULL,
        direction      text        NOT NULL,
        amount         bigint      NOT NULL,
        balance_after  bigint      NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
        transfer_status text GENERATED ALWAYS AS ('COMPLETED') STORED,
        debit_account  uuid GENERATED ALWAYS AS
          (CASE WHEN direction = 'DEBIT' THEN account_id END) STORED,
        credit_account uuid GENERATED ALWAYS AS
          (CASE WHEN direction = 'CREDIT' THEN account_id END) STORED,
        CONSTRAINT ledger_entries_pkey PRIMARY KEY (id),
        CONSTRAINT ledger_entries_direction_check CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT ledger_entries_amount_check CHECK (amount > 0),
        CONSTRAINT ledger_entries_one_per_direction UNIQUE (transfer_id, direction),
        CONSTRAINT ledger_entries_transfer_debit_fkey
          FOREIGN KEY (transfer_id, amount, transfer_status, debit_account)
          REFERENCES transfers (id, amount, status, from_account_id) ON DELETE RESTRICT,
        CONSTRAINT ledger_entries_transfer_credit_fkey
          FOREIGN KEY (transfer_id, amount, transfer_status, credit_account)
          REFERENCES transfers (id, amount, status, to_account_id) ON DELETE RESTRICT
      )`);

    // Daily limit: SUM of an account's DEBIT lines since midnight (Asia/Ho_Chi_Minh), read while the
    // account row is locked. INCLUDE (amount) makes it an index-only scan, so the hot path never
    // touches the table.
    await queryRunner.query(`
      CREATE INDEX ledger_entries_daily_debit_idx ON ledger_entries (account_id, created_at)
        INCLUDE (amount)
        WHERE direction = 'DEBIT'`);
    // Transaction history with a (created_at, id) cursor (UC-6): stable when lines share a time.
    await queryRunner.query(`
      CREATE INDEX ledger_entries_account_history_idx
        ON ledger_entries (account_id, created_at DESC, id DESC)`);

    // The key is per user: a global unique key would hand user A the stored response of user B.
    // transfer_id and response_* are NULL because the row is reserved first (INSERT ... ON CONFLICT
    // DO NOTHING) and the result is only known at the end of the transaction; request_hash is the
    // sha256 hex of the request.
    await queryRunner.query(`
      CREATE TABLE idempotency_keys (
        user_id       uuid        NOT NULL,
        idem_key      text        NOT NULL,
        request_hash  char(64)    NOT NULL,
        transfer_id   uuid,
        response_code smallint,
        response_body jsonb,
        created_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT idempotency_keys_pkey PRIMARY KEY (user_id, idem_key),
        CONSTRAINT idempotency_keys_user_id_fkey FOREIGN KEY (user_id)
          REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT idempotency_keys_transfer_id_fkey FOREIGN KEY (transfer_id)
          REFERENCES transfers (id) ON DELETE RESTRICT,
        CONSTRAINT idempotency_keys_idem_key_check
          CHECK (char_length(idem_key) BETWEEN 1 AND 128)
      )`);
    // The cleanup job deletes keys older than 7 days (ADR-05).
    await queryRunner.query(
      'CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at)',
    );

    // The read-only contract the risk module reads instead of `transfers` itself (§8.2). The view
    // runs with its owner's rights (no security_invoker on purpose), so the worker role later needs
    // SELECT on the view only, never on transfers. Its columns are what risk may rely on: ledger
    // changes `transfers`, then edits the view.
    await queryRunner.query(`
      CREATE VIEW v_transfer_facts AS
        SELECT id, type, from_account_id, to_account_id, amount, status, created_at
        FROM transfers`);
  }

  /**
   * `npm run migration:revert` runs against whatever DATABASE_URL points at, and DROP TABLE takes
   * every transfer, ledger line and idempotency key with it. Ledger rows are never deleted in a
   * bank, so the revert only goes through while all three tables are still empty, as `up` left
   * them; otherwise it throws and the migration transaction rolls back.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const [rows] = (await queryRunner.query(`
      SELECT (SELECT count(*) FROM transfers)::int        AS transfers,
             (SELECT count(*) FROM ledger_entries)::int   AS ledger_entries,
             (SELECT count(*) FROM idempotency_keys)::int AS idempotency_keys`)) as {
      transfers: number;
      ledger_entries: number;
      idempotency_keys: number;
    }[];
    if (rows.transfers > 0 || rows.ledger_entries > 0 || rows.idempotency_keys > 0) {
      throw new Error(
        `Refusing to revert ${this.name}: tables hold data ` +
          `(transfers=${rows.transfers}, ledger_entries=${rows.ledger_entries}, ` +
          `idempotency_keys=${rows.idempotency_keys}). Reverting would drop it.`,
      );
    }

    await queryRunner.query('DROP VIEW v_transfer_facts');
    await queryRunner.query('DROP TABLE idempotency_keys');
    await queryRunner.query('DROP TABLE ledger_entries');
    await queryRunner.query('DROP TABLE transfers');
  }
}
