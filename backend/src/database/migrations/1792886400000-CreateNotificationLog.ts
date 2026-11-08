import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class CreateNotificationLog1792886400000 implements MigrationInterface {
  name = 'CreateNotificationLog1792886400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE notification_log (
      id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT notification_log_pkey PRIMARY KEY,
      event_id uuid NOT NULL,
      kind text NOT NULL CONSTRAINT notification_log_kind_check
        CHECK (kind IN ('transfer_completed', 'account_status_changed')),
      user_id uuid CONSTRAINT notification_log_user_id_fkey REFERENCES users(id) ON DELETE RESTRICT,
      message text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    // BR-13 is a writer responsibility: arbitrary text cannot be semantically checked by SQL.
    await queryRunner.query(`COMMENT ON COLUMN notification_log.message IS
      'BR-13: Generic notification only; never disclose fraud reasons. Enforced by the notification writer.'`);
    await queryRunner.query(
      'CREATE INDEX notification_log_event_id_idx ON notification_log (event_id)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) {
      throw Object.assign(new Error('Reverting notification_log requires a transaction'), {
        code: '55000',
      });
    }
    await queryRunner.query(`DO $$ BEGIN
      IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Reverting notification_log requires READ COMMITTED' USING ERRCODE = '55000';
      END IF;
    END $$`);
    await queryRunner.query('LOCK TABLE public.notification_log IN ACCESS EXCLUSIVE MODE');
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM public.notification_log) THEN
        RAISE EXCEPTION 'Refusing to revert notification_log: table holds data' USING ERRCODE = '55000';
      END IF;
    END $$`);
    await queryRunner.query('DROP TABLE public.notification_log');
  }
}
