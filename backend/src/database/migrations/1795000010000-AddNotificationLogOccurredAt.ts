import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BL-211: `notification_log.occurred_at`, the time the event happened (`event.occurredAt`).
 *
 * The event contract does not order delivery (ADR-03: SQS standard, at-least-once, no order), so a
 * worker can process "account unlocked" before the "account locked" it undoes. A reader that sorts
 * by `id` or `created_at` (the time of processing) then shows the unlock first. Every reader of
 * the table sorts by `occurred_at, id` instead; the consumer writes the column from the event.
 *
 * Existing rows are backfilled from `created_at`: the event time is not kept anywhere else for
 * them (the outbox row that held it is deleted after 7 days), and processing time is what their
 * readers used until now, so their relative order does not change.
 *
 * `NOT NULL DEFAULT now()`: during a rolling deploy a worker of the previous release keeps
 * inserting without the column (DBS-134 handled the same case for `correlation_id` by leaving it
 * nullable). With the default such a row gets its processing time, exactly the old behaviour. The
 * consumer of this release always writes the event time and a spec checks it. `now()` is not a volatile default, so
 * ADD COLUMN is a catalog change only on PostgreSQL 11+; the UPDATE that follows rewrites every
 * row once, which is fine for this table (two rows per transfer at most, one per status change).
 *
 * Grants: none to add. `dbs_worker` has table-level SELECT, INSERT and DELETE on the table
 * (migration 1793664000000, `infra/scripts/db-roles.sql`), which covers new columns; `dbs_api` has
 * no access. No index yet: no API reads the table (v1 "notification" is a log line, docs/03 section
 * 6.3). The first reader per user adds `(user_id, occurred_at, id)` together with its query.
 */
export class AddNotificationLogOccurredAt1795000010000 implements MigrationInterface {
  name = 'AddNotificationLogOccurredAt1795000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE notification_log ADD COLUMN occurred_at timestamptz NOT NULL DEFAULT now()',
    );
    await queryRunner.query('UPDATE notification_log SET occurred_at = created_at');
    await queryRunner.query(`COMMENT ON COLUMN notification_log.occurred_at IS
      'event.occurredAt (BL-211): sort notices by this, then id; created_at is when a worker processed the event, and delivery order is not guaranteed.'`);
  }

  /** Drops a sort column only, never a notice, so it is allowed on a table with data. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE notification_log DROP COLUMN occurred_at');
  }
}
