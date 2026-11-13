-- Postgres roles and grants of the application (database-design §8). Idempotent: run it as the
-- database owner (dbs_migrator, or the master user on RDS) AFTER every `migration:run`, because a
-- new table has no grants until it is listed here.
--
--   dbs_migrator the migration execution runner (DDL owner)
--   dbs_api      the ECS service `api`
--   dbs_worker   the ECS service `worker` (relay, consumers, cleanup)
--
-- On RDS the user that runs this file or `migration:run` is the master user, which is not a real
-- superuser. `ALTER VIEW ... OWNER TO dbs_migrator` below (and in migration 1793664000000) needs
-- the right to SET ROLE to dbs_migrator, so before the FIRST migration of a database the master
-- must hold it: create the role if missing, then `GRANT dbs_migrator TO <master>;` (BL-195,
-- infra/terraform/README.md "Role chạy migration"). Neither this file nor the migration grants it
-- to the user that runs them.
--
-- The roles are created NOLOGIN. Whoever provisions the database gives them a login and a password
-- from Secrets Manager (BL-103, DBS-119): `ALTER ROLE dbs_api LOGIN PASSWORD '...'`. The
-- application must never connect as the owner of the tables.
--
-- Nobody gets UPDATE or DELETE on ledger_entries, transfers or audit_log; the append-only triggers
-- of DBS-27 are the second line behind these grants. `SELECT ... FOR UPDATE` needs UPDATE on at
-- least one column of the table, which is why accounts has a column-level UPDATE.

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

-- dbs_migrator grants & default privileges
GRANT USAGE, CREATE ON SCHEMA public TO dbs_migrator;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO dbs_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO dbs_migrator;
GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO dbs_migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO dbs_migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO dbs_migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO dbs_migrator;

-- Transfer view ownership of v_transfer_facts to dbs_migrator (BL-005)
-- The view runs with its owner's rights (no security_invoker on purpose), so dbs_worker
-- can query the contract columns without requiring SELECT privilege on transfers.
ALTER VIEW public.v_transfer_facts OWNER TO dbs_migrator;

-- Start from nothing so that a grant removed from this file is removed from the database too.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dbs_api, dbs_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM dbs_api, dbs_worker;
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM dbs_api, dbs_worker;
GRANT USAGE ON SCHEMA public TO dbs_api, dbs_worker;

-- dbs_api
GRANT SELECT, INSERT ON users TO dbs_api;
GRANT UPDATE (sessions_revoked_at) ON users TO dbs_api;
GRANT SELECT, INSERT ON customers TO dbs_api;
-- POST /v1/accounts locks the customer row (SELECT ... FOR UPDATE, BR-14), and PostgreSQL asks for the
-- UPDATE privilege on at least one column for any row lock. full_name is the one column that may
-- legitimately change later; user_id and created_at stay unchangeable.
GRANT UPDATE (full_name) ON customers TO dbs_api;
GRANT SELECT, INSERT ON accounts TO dbs_api;
GRANT UPDATE (balance, status, updated_at) ON accounts TO dbs_api;
GRANT SELECT, INSERT ON transfers TO dbs_api;
GRANT SELECT, INSERT ON ledger_entries TO dbs_api;
GRANT SELECT, INSERT ON idempotency_keys TO dbs_api;
GRANT UPDATE (transfer_id, response_code, response_body) ON idempotency_keys TO dbs_api;
GRANT INSERT ON outbox_events TO dbs_api;
GRANT SELECT, INSERT ON audit_log TO dbs_api;
GRANT SELECT ON fraud_flags TO dbs_api;
GRANT UPDATE (review_status, reviewed_by, reviewed_at, review_note) ON fraud_flags TO dbs_api;
GRANT SELECT ON fraud_rule_hits TO dbs_api;
GRANT SELECT ON v_transfer_facts TO dbs_api;
GRANT SELECT, INSERT ON risk_rule_sets TO dbs_api;
GRANT SELECT ON reconciliation_runs TO dbs_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dbs_api;

-- dbs_worker
GRANT SELECT ON accounts TO dbs_worker;
GRANT SELECT ON v_transfer_facts TO dbs_worker;
GRANT SELECT ON ledger_entries TO dbs_worker;
GRANT SELECT, DELETE ON idempotency_keys TO dbs_worker;
-- DELETE here covers every row, but the trigger outbox_events_no_delete_unpublished (BL-180,
-- migration 1795000004000) refuses to delete a row with published_at IS NULL, so only the cleanup
-- of published rows can succeed.
GRANT SELECT, DELETE ON outbox_events TO dbs_worker;
GRANT UPDATE (published_at) ON outbox_events TO dbs_worker;
GRANT SELECT, INSERT, DELETE ON processed_events TO dbs_worker;
GRANT INSERT ON audit_log TO dbs_worker;
GRANT SELECT, INSERT ON fraud_flags TO dbs_worker;
GRANT SELECT, INSERT ON fraud_rule_hits TO dbs_worker;
GRANT SELECT ON risk_rule_sets TO dbs_worker;
GRANT SELECT, INSERT, DELETE ON notification_log TO dbs_worker;
GRANT SELECT, INSERT, DELETE ON reconciliation_runs TO dbs_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dbs_worker;

-- RSK-01: risk_decisions exists only from migration 1793836800000 on. The guard lets this file run
-- on a database migrated only up to step 7 (TC-119-01) as well as on a full one.
DO $$
BEGIN
  IF to_regclass('public.risk_decisions') IS NOT NULL THEN
    GRANT SELECT ON public.risk_decisions TO dbs_api;
    GRANT SELECT, INSERT ON public.risk_decisions TO dbs_worker;
  END IF;
END $$;

-- RSK-02: gate functions only; no gate-table privileges and no API execution.
DO $$
BEGIN
  IF to_regprocedure('public.ai_gate_acquire(uuid,text,integer,integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.ai_gate_acquire(uuid,text,integer,integer) TO dbs_worker;
  END IF;
  IF to_regprocedure('public.ai_gate_release(uuid)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.ai_gate_release(uuid) TO dbs_worker;
  END IF;
END $$;
