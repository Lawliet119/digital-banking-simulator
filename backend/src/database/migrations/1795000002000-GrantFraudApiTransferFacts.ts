import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Operator fraud endpoints read the existing transfer-facts view; no write privilege is added. */
export class GrantFraudApiTransferFacts1795000002000 implements MigrationInterface {
  name = 'GrantFraudApiTransferFacts1795000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_api') THEN
          GRANT SELECT ON public.v_transfer_facts TO dbs_api;
        END IF;
      END $$`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_api') THEN
          REVOKE SELECT ON public.v_transfer_facts FROM dbs_api;
        END IF;
      END $$`);
  }
}
