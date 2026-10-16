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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE transfers');
  }
}
