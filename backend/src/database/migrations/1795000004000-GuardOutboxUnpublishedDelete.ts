import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BL-180: dbs_worker holds DELETE on every row of outbox_events (the cleanup job needs it), so
 * "never delete an unpublished row" was guarded only by the `published_at IS NOT NULL` of the
 * cleanup query. This puts the rule in the database: a row trigger refuses to delete a row whose
 * `published_at IS NULL`, whoever asks (owner included), with the same SQLSTATE 42501 and message
 * style as forbid_mutation() (DBS-27).
 *
 * Not covered on purpose: TRUNCATE (a row trigger does not fire; dbs_api and dbs_worker hold no
 * TRUNCATE privilege, so only the table owner or a superuser can do it) and a session that sets
 * session_replication_role = replica (superuser only).
 *
 * Needs ownership of public.outbox_events (CREATE TRIGGER) and CREATE on schema public: the same
 * rights every earlier migration already uses. No grant changes, so db-roles.sql is unchanged.
 */
export class GuardOutboxUnpublishedDelete1795000004000 implements MigrationInterface {
  name = 'GuardOutboxUnpublishedDelete1795000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE FUNCTION public.forbid_delete_unpublished_outbox() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        IF OLD.published_at IS NULL THEN
          RAISE EXCEPTION 'DELETE on % of an unpublished row is not allowed (published_at IS NULL)', TG_TABLE_NAME
            USING ERRCODE = '42501';
        END IF;
        RETURN OLD;
      END;
      $$`);
    await queryRunner.query(`CREATE TRIGGER outbox_events_no_delete_unpublished
      BEFORE DELETE ON public.outbox_events
      FOR EACH ROW EXECUTE FUNCTION public.forbid_delete_unpublished_outbox()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TRIGGER outbox_events_no_delete_unpublished ON public.outbox_events',
    );
    await queryRunner.query('DROP FUNCTION public.forbid_delete_unpublished_outbox()');
  }
}
