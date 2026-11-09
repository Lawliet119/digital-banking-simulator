import { type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * DBS-134: every notice records the correlationId of the event that caused it, so one id links the
 * audit rows, the outbox event and the notice.
 *
 * The column is nullable on purpose. Rows written before this migration are linked from
 * `outbox_events` when that row still exists (the cleanup job removes old ones), and a worker still
 * on the previous release may keep inserting without the column during a rolling deploy.
 */
export class AddNotificationLogCorrelationId1793750400000 implements MigrationInterface {
  name = 'AddNotificationLogCorrelationId1793750400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE notification_log ADD COLUMN correlation_id uuid');
    await queryRunner.query(`UPDATE notification_log n SET correlation_id = o.correlation_id
      FROM outbox_events o WHERE o.event_id = n.event_id`);
  }

  /** Drops only a traceability column, never a notice, so it is allowed on a table with data. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE notification_log DROP COLUMN correlation_id');
  }
}
