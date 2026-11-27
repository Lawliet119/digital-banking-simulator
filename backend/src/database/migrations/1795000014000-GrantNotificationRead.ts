import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * UI plan, stage B: the api reads a customer's notices (`GET /v1/notifications`).
 *
 * `dbs_api` gets SELECT on `notification_log` and nothing else: only the worker writes it. The
 * index serves that read, `user_id` first and then the order of the list, `occurred_at, id`
 * (BL-211); `1795000010000` left it to the first per-user reader.
 *
 * CREATE INDEX blocks writes to the table while it builds (it cannot be CONCURRENTLY inside the
 * migration transaction). Only the notification consumer writes it and it retries, so no money
 * path waits.
 */
export class GrantNotificationRead1795000014000 implements MigrationInterface {
  name = 'GrantNotificationRead1795000014000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'");
    await queryRunner.query(`CREATE INDEX notification_log_user_idx
      ON public.notification_log (user_id, occurred_at DESC, id DESC)`);
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_api') THEN
        GRANT SELECT ON public.notification_log TO dbs_api;
      END IF;
    END $$`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'");
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_api') THEN
        REVOKE SELECT ON public.notification_log FROM dbs_api;
      END IF;
    END $$`);
    await queryRunner.query('DROP INDEX public.notification_log_user_idx');
  }
}
