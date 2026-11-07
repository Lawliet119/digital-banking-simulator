-- Postgres roles and grants of the application (database-design §8). Idempotent: run it as the
-- database owner (dbs_migrator, or the master user on RDS) AFTER every `migration:run`, because a
-- new table has no grants until it is listed here.
--
--   dbs_api     the ECS service `api`
--   dbs_worker  the ECS service `worker` (relay, consumers, cleanup)
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
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_api') THEN
    CREATE ROLE dbs_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_worker') THEN
    CREATE ROLE dbs_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Start from nothing so that a grant removed from this file is removed from the database too.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dbs_api, dbs_worker;
GRANT USAGE ON SCHEMA public TO dbs_api, dbs_worker;

-- dbs_api
GRANT SELECT, INSERT ON users TO dbs_api;
GRANT UPDATE (sessions_revoked_at) ON users TO dbs_api;
GRANT SELECT, INSERT ON customers TO dbs_api;
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
GRANT SELECT, INSERT ON risk_rule_sets TO dbs_api;

-- dbs_worker
GRANT SELECT ON accounts TO dbs_worker;
GRANT SELECT ON v_transfer_facts TO dbs_worker;
GRANT SELECT ON ledger_entries TO dbs_worker;
GRANT DELETE ON idempotency_keys TO dbs_worker;
GRANT SELECT, DELETE ON idempotency_keys TO dbs_worker;
GRANT SELECT, DELETE ON outbox_events TO dbs_worker;
GRANT UPDATE (published_at) ON outbox_events TO dbs_worker;
GRANT SELECT, INSERT, DELETE ON processed_events TO dbs_worker;
GRANT INSERT ON audit_log TO dbs_worker;
GRANT SELECT, INSERT ON fraud_flags TO dbs_worker;
GRANT SELECT, INSERT ON fraud_rule_hits TO dbs_worker;
GRANT SELECT ON risk_rule_sets TO dbs_worker;
