import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * UI v2, stage 1: a notice says which transfer and which of the reader's accounts it is about, and
 * whether it has been read.
 *
 * `transfer_id`, `account_id`, `counterparty_account_id` and `direction` come from the event, so
 * the worker writes them without reading anything new. No amount or balance is copied: the api
 * reads both from `ledger_entries`, so money has one source. All are nullable: rows written before
 * this migration, and by a worker of the previous release during a rolling deploy, keep NULL and
 * show their sentence only. No foreign key: a notice must never fail on, or lock, a money table.
 *
 * `read_at` is the one column the api may write (`UPDATE (read_at)`); it still cannot change a
 * text, an owner or a time, and cannot delete.
 */
export class AddNotificationDetail1795000015000 implements MigrationInterface {
  name = 'AddNotificationDetail1795000015000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'");
    await queryRunner.query(`ALTER TABLE public.notification_log
      ADD COLUMN transfer_id uuid,
      ADD COLUMN account_id uuid,
      ADD COLUMN counterparty_account_id uuid,
      ADD COLUMN direction text
        CONSTRAINT notification_log_direction_check CHECK (direction IN ('DEBIT', 'CREDIT')),
      ADD COLUMN read_at timestamptz`);
    await queryRunner.query(`CREATE INDEX notification_log_unread_idx
      ON public.notification_log (user_id) WHERE read_at IS NULL`);
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_api') THEN
        GRANT UPDATE (read_at) ON public.notification_log TO dbs_api;
      END IF;
    END $$`);
  }

  /** Drops detail and read marks only, never a notice, so it is allowed on a table with data. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'");
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_api') THEN
        REVOKE UPDATE (read_at) ON public.notification_log FROM dbs_api;
      END IF;
    END $$`);
    await queryRunner.query('DROP INDEX public.notification_log_unread_idx');
    await queryRunner.query(`ALTER TABLE public.notification_log
      DROP COLUMN read_at,
      DROP COLUMN direction,
      DROP COLUMN counterparty_account_id,
      DROP COLUMN account_id,
      DROP COLUMN transfer_id`);
  }
}
