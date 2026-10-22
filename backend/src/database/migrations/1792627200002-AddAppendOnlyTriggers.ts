import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAppendOnlyTriggers1792627200002 implements MigrationInterface {
  name = 'AddAppendOnlyTriggers1792627200002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE FUNCTION public.forbid_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME
          USING ERRCODE = '42501';
      END;
      $$`);
    for (const table of ['ledger_entries', 'transfers', 'audit_log']) {
      await queryRunner.query(`CREATE TRIGGER ${table}_append_only
        BEFORE UPDATE OR DELETE ON public.${table}
        FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation()`);
      await queryRunner.query(`CREATE TRIGGER ${table}_no_truncate
        BEFORE TRUNCATE ON public.${table}
        FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation()`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['ledger_entries', 'transfers', 'audit_log']) {
      await queryRunner.query(`DROP TRIGGER ${table}_append_only ON public.${table}`);
      await queryRunner.query(`DROP TRIGGER ${table}_no_truncate ON public.${table}`);
    }
    await queryRunner.query('DROP FUNCTION public.forbid_mutation()');
  }
}
