import { type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Migration step 7 (database-design §8.1 & §11):
 * Creates dbs_migrator, dbs_api, dbs_worker roles and grants permissions according to the
 * least-privilege matrix.
 *
 * Idempotent: safe to run multiple times.
 */
export class CreateDbRolesAndGrants1793664000000 implements MigrationInterface {
  name = 'CreateDbRolesAndGrants1793664000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create roles if they do not exist
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_migrator') THEN
          CREATE ROLE dbs_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_api') THEN
          CREATE ROLE dbs_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_worker') THEN
          CREATE ROLE dbs_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
        END IF;
      END $$;
    `);

    // 2. Grant DDL and ownership privileges to dbs_migrator
    await queryRunner.query(`
      GRANT USAGE, CREATE ON SCHEMA public TO dbs_migrator;
      GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO dbs_migrator;
      GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO dbs_migrator;
      GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO dbs_migrator;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO dbs_migrator;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO dbs_migrator;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO dbs_migrator;
    `);

    // 3. Transfer view ownership of v_transfer_facts to dbs_migrator (BL-005)
    // The view runs with its owner's rights (no security_invoker on purpose), so dbs_worker
    // can query the contract columns without requiring SELECT privilege on transfers.
    await queryRunner.query(`
      ALTER VIEW public.v_transfer_facts OWNER TO dbs_migrator;
    `);

    // 4. Start from nothing for dbs_api and dbs_worker to guarantee idempotency
    await queryRunner.query(`
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dbs_api, dbs_worker;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM dbs_api, dbs_worker;
      REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM dbs_api, dbs_worker;
      GRANT USAGE ON SCHEMA public TO dbs_api, dbs_worker;
    `);

    // 5. Grant least-privilege matrix to dbs_api
    await queryRunner.query(`
      GRANT SELECT, INSERT ON public.users TO dbs_api;
      GRANT UPDATE (sessions_revoked_at) ON public.users TO dbs_api;

      GRANT SELECT, INSERT ON public.customers TO dbs_api;
      -- POST /v1/accounts locks the customer row (SELECT ... FOR UPDATE, BR-14),
      -- which requires UPDATE privilege on at least one column.
      GRANT UPDATE (full_name) ON public.customers TO dbs_api;

      GRANT SELECT, INSERT ON public.accounts TO dbs_api;
      GRANT UPDATE (balance, status, updated_at) ON public.accounts TO dbs_api;

      GRANT SELECT, INSERT ON public.transfers TO dbs_api;
      GRANT SELECT, INSERT ON public.ledger_entries TO dbs_api;

      GRANT SELECT, INSERT ON public.idempotency_keys TO dbs_api;
      GRANT UPDATE (transfer_id, response_code, response_body) ON public.idempotency_keys TO dbs_api;

      GRANT INSERT ON public.outbox_events TO dbs_api;
      GRANT SELECT, INSERT ON public.audit_log TO dbs_api;

      GRANT SELECT ON public.fraud_flags TO dbs_api;
      GRANT UPDATE (review_status, reviewed_by, reviewed_at, review_note) ON public.fraud_flags TO dbs_api;
      GRANT SELECT ON public.fraud_rule_hits TO dbs_api;

      GRANT SELECT, INSERT ON public.risk_rule_sets TO dbs_api;
      GRANT SELECT ON public.reconciliation_runs TO dbs_api;

      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dbs_api;
    `);

    // 6. Grant least-privilege matrix to dbs_worker
    await queryRunner.query(`
      GRANT SELECT ON public.accounts TO dbs_worker;
      GRANT SELECT ON public.v_transfer_facts TO dbs_worker;
      GRANT SELECT ON public.ledger_entries TO dbs_worker;

      GRANT SELECT, DELETE ON public.idempotency_keys TO dbs_worker;

      GRANT SELECT, DELETE ON public.outbox_events TO dbs_worker;
      GRANT UPDATE (published_at) ON public.outbox_events TO dbs_worker;

      GRANT SELECT, INSERT, DELETE ON public.processed_events TO dbs_worker;
      GRANT INSERT ON public.audit_log TO dbs_worker;

      GRANT SELECT, INSERT ON public.fraud_flags TO dbs_worker;
      GRANT SELECT, INSERT ON public.fraud_rule_hits TO dbs_worker;
      GRANT SELECT ON public.risk_rule_sets TO dbs_worker;

      GRANT SELECT, INSERT, DELETE ON public.notification_log TO dbs_worker;
      GRANT SELECT, INSERT, DELETE ON public.reconciliation_runs TO dbs_worker;

      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dbs_worker;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Restore view owner to current user before revoking dbs_migrator
    await queryRunner.query(`
      ALTER VIEW public.v_transfer_facts OWNER TO CURRENT_USER;
    `);

    // 2. Revoke default privileges
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM dbs_migrator;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM dbs_migrator;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM dbs_migrator;
    `);

    // 3. Revoke all object privileges from all 3 roles
    await queryRunner.query(`
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dbs_api, dbs_worker, dbs_migrator;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM dbs_api, dbs_worker, dbs_migrator;
      REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM dbs_api, dbs_worker, dbs_migrator;
      REVOKE USAGE, CREATE ON SCHEMA public FROM dbs_api, dbs_worker, dbs_migrator;
    `);
  }
}
