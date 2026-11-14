import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BL-181: a durable place for an outbox event that can never be sent (SQS answers 400 for it again
 * and again). Until now the relay only set such an event aside in memory: lost at every restart,
 * capped at 1000 ids, and invisible to any alarm.
 *
 * Four columns on `outbox_events`:
 * - `attempts`: how many times a send of this event failed for a reason that will repeat;
 * - `last_attempt_at`: when the last of those failures happened (database clock);
 * - `last_error_code`: a short code (`SQS_400_InvalidParameterValue`), never a message and never
 *   any part of the payload; the CHECK keeps text with spaces or data out of the column;
 * - `quarantined_at`: set by the relay when `attempts` reaches its limit; from then on the relay
 *   does not select the row. The row stays `published_at IS NULL`, so the BL-180 trigger still
 *   forbids deleting it, and an operator re-queues it with
 *   `UPDATE outbox_events SET quarantined_at = NULL, attempts = 0 WHERE id = ...`.
 *
 * Indexes: `outbox_unpublished_idx` (the relay's poll and the age gauge) now leaves quarantined
 * rows out, so they neither cost the poll a skip nor keep the age alarm firing; the new
 * `outbox_quarantined_idx` is what the quarantine gauge counts on. Both are partial and tiny.
 *
 * ADD COLUMN with a constant DEFAULT is a catalog change only (PostgreSQL 11+); the index
 * rebuilds hold the table lock for the length of a scan of the unpublished rows, which is a few.
 *
 * Grants: `dbs_worker` may UPDATE the four columns (column level, like `published_at`); `dbs_api`
 * only inserts and gets nothing new. Applied here when the role exists, and kept in sync in
 * infra/scripts/db-roles.sql.
 */
export class QuarantineOutboxEvents1795000009000 implements MigrationInterface {
  name = 'QuarantineOutboxEvents1795000009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE outbox_events
      ADD COLUMN attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN last_attempt_at timestamptz,
      ADD COLUMN last_error_code text,
      ADD COLUMN quarantined_at timestamptz,
      ADD CONSTRAINT outbox_events_attempts_check CHECK (attempts >= 0),
      ADD CONSTRAINT outbox_events_last_error_code_check
        CHECK (last_error_code ~ '^[A-Za-z0-9_.:-]{1,80}$')`);
    await queryRunner.query('DROP INDEX outbox_unpublished_idx');
    await queryRunner.query(`CREATE INDEX outbox_unpublished_idx
      ON outbox_events (id) WHERE published_at IS NULL AND quarantined_at IS NULL`);
    await queryRunner.query(`CREATE INDEX outbox_quarantined_idx
      ON outbox_events (id) WHERE quarantined_at IS NOT NULL AND published_at IS NULL`);
    await queryRunner.query(`DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_worker') THEN
          GRANT UPDATE (attempts, last_attempt_at, last_error_code, quarantined_at)
            ON public.outbox_events TO dbs_worker;
        END IF;
      END $$`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive)
      throw new Error('Reverting the outbox quarantine requires a transaction');
    await queryRunner.query('LOCK TABLE outbox_events IN ACCESS EXCLUSIVE MODE');
    // Dropping the columns would put quarantined events back in the relay's retry loop without a
    // trace. Re-queue or publish them first.
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM outbox_events WHERE quarantined_at IS NOT NULL AND published_at IS NULL) THEN
        RAISE EXCEPTION 'Refusing to revert: quarantined outbox events exist' USING ERRCODE = '55000';
      END IF;
    END $$`);
    await queryRunner.query(`DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_worker') THEN
          REVOKE UPDATE (attempts, last_attempt_at, last_error_code, quarantined_at)
            ON public.outbox_events FROM dbs_worker;
        END IF;
      END $$`);
    await queryRunner.query('DROP INDEX outbox_quarantined_idx');
    await queryRunner.query('DROP INDEX outbox_unpublished_idx');
    await queryRunner.query(`CREATE INDEX outbox_unpublished_idx
      ON outbox_events (id) WHERE published_at IS NULL`);
    await queryRunner.query(`ALTER TABLE outbox_events
      DROP COLUMN attempts,
      DROP COLUMN last_attempt_at,
      DROP COLUMN last_error_code,
      DROP COLUMN quarantined_at`);
  }
}
