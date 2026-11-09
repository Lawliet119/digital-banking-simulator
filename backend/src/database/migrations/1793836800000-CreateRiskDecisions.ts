import type { MigrationInterface, QueryRunner } from 'typeorm';

const refuse = (message: string) => Object.assign(new Error(message), { code: '55000' });

/**
 * RSK-01 (ADR-14): `risk_decisions`, one immutable row per scored TRANSFER in every mode, written
 * by the risk consumer (DBS-111) before any flag. Schema: FRAUD-API-01 §3.8, with every constraint
 * named. `fraud_flags` gains a composite key to it, so a flag can only exist for a decision of the
 * same rule-set version. Design and decisions: docs/features/RSK-01-risk-decisions-migration.md.
 *
 * `fraud_flags` already exists (DBS-58) but nothing writes it before DBS-111, so the key is added
 * with ALTER on an empty table. A flag without a decision stops the migration (55000): a decision
 * is evidence and is never invented.
 */
export class CreateRiskDecisions1793836800000 implements MigrationInterface {
  name = 'CreateRiskDecisions1793836800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'");
    // ADD CHECK needs ACCESS EXCLUSIVE on fraud_rule_hits; take it first so no lock is upgraded
    // midway. SHARE ROW EXCLUSIVE on fraud_flags is what ADD FOREIGN KEY takes, and it stops new
    // flags between the count and the key.
    await queryRunner.query('LOCK TABLE fraud_rule_hits IN ACCESS EXCLUSIVE MODE');
    await queryRunner.query('LOCK TABLE fraud_flags IN SHARE ROW EXCLUSIVE MODE');
    const [{ flags }] = (await queryRunner.query(
      'SELECT count(*)::int AS flags FROM fraud_flags',
    )) as { flags: number }[];
    if (flags !== 0) {
      throw refuse('Refusing to add risk_decisions: fraud_flags has rows without a decision');
    }

    await queryRunner.query(`CREATE TABLE risk_decisions (
      transfer_id uuid NOT NULL,
      event_id uuid NOT NULL,
      rule_set_version int NOT NULL,
      mode text NOT NULL,
      rule_score int NOT NULL,
      feature_snapshot jsonb NOT NULL,
      ai_status text NOT NULL,
      ai_applied_weight int NOT NULL,
      probability double precision,
      provider text,
      requested_model text,
      response_model text,
      rubric_sha256 text,
      input_sha256 text,
      provider_request_id text,
      decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT risk_decisions_pkey PRIMARY KEY (transfer_id),
      CONSTRAINT risk_decisions_transfer_id_fkey FOREIGN KEY (transfer_id)
        REFERENCES transfers(id) ON DELETE RESTRICT,
      CONSTRAINT risk_decisions_rule_set_version_fkey FOREIGN KEY (rule_set_version)
        REFERENCES risk_rule_sets(version) ON DELETE RESTRICT,
      CONSTRAINT risk_decisions_transfer_version UNIQUE (transfer_id, rule_set_version),
      CONSTRAINT risk_decisions_mode_check CHECK (mode IN ('rule_only','rules_with_external_ai')),
      CONSTRAINT risk_decisions_rule_score_check CHECK (rule_score >= 0),
      CONSTRAINT risk_decisions_feature_snapshot_check
        CHECK (jsonb_typeof(feature_snapshot) = 'object'),
      CONSTRAINT risk_decisions_ai_status_check CHECK (ai_status IN
        ('DISABLED','SUCCEEDED','UNAVAILABLE','REFUSED','INVALID_RESPONSE','BUDGET_EXHAUSTED','CONFIG_INVALID')),
      CONSTRAINT risk_decisions_ai_applied_weight_check CHECK (ai_applied_weight >= 0),
      CONSTRAINT risk_decisions_rubric_sha256_check CHECK (rubric_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT risk_decisions_input_sha256_check CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT risk_decisions_total_fits_int
        CHECK (rule_score::bigint + ai_applied_weight::bigint <= 2147483647),
      CONSTRAINT risk_decisions_mode_metadata CHECK (
        (mode = 'rule_only' AND ai_status = 'DISABLED'
          AND probability IS NULL AND ai_applied_weight = 0
          AND provider IS NULL AND requested_model IS NULL AND response_model IS NULL
          AND rubric_sha256 IS NULL AND input_sha256 IS NULL AND provider_request_id IS NULL)
        OR
        (mode = 'rules_with_external_ai' AND ai_status NOT IN ('DISABLED','CONFIG_INVALID')
          AND provider IS NOT NULL AND requested_model IS NOT NULL
          AND rubric_sha256 IS NOT NULL AND input_sha256 IS NOT NULL)
        OR
        (mode = 'rules_with_external_ai' AND ai_status = 'CONFIG_INVALID'
          AND probability IS NULL AND ai_applied_weight = 0
          AND response_model IS NULL AND provider_request_id IS NULL)
      ),
      -- NaN, Infinity and -Infinity fail "probability <= 1": PostgreSQL orders NaN above every number.
      CONSTRAINT risk_decisions_status_probability CHECK (
        (ai_status = 'SUCCEEDED' AND probability IS NOT NULL
          AND probability >= 0 AND probability <= 1)
        OR
        (ai_status <> 'SUCCEEDED' AND probability IS NULL AND ai_applied_weight = 0)
      )
    )`);
    await queryRunner.query(`CREATE TRIGGER risk_decisions_append_only
      BEFORE UPDATE OR DELETE ON public.risk_decisions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation()`);
    await queryRunner.query(`CREATE TRIGGER risk_decisions_no_truncate
      BEFORE TRUNCATE ON public.risk_decisions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation()`);

    await queryRunner.query(`ALTER TABLE fraud_flags ADD CONSTRAINT fraud_flags_decision_fkey
      FOREIGN KEY (transfer_id, rule_set_version)
      REFERENCES risk_decisions (transfer_id, rule_set_version) ON DELETE RESTRICT`);
    await queryRunner.query(`ALTER TABLE fraud_rule_hits
      ADD CONSTRAINT fraud_rule_hits_weight_check CHECK (weight >= 0)`);

    // Matrix §8.1: the worker claims decisions, the API only reads them for operators. The roles
    // exist once DBS-119 step 7 has run; an older database gets the grants from db-roles.sql.
    await queryRunner.query(`DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_api') THEN
          GRANT SELECT ON public.risk_decisions TO dbs_api;
        END IF;
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_worker') THEN
          GRANT SELECT, INSERT ON public.risk_decisions TO dbs_worker;
        END IF;
      END $$`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) {
      throw refuse('Refusing to revert risk_decisions outside a transaction');
    }
    const [{ isolation }] = (await queryRunner.query(
      "SELECT current_setting('transaction_isolation') AS isolation",
    )) as { isolation: string }[];
    if (isolation !== 'read committed') {
      throw refuse('Refusing to revert risk_decisions without READ COMMITTED');
    }
    await queryRunner.query(
      'LOCK TABLE fraud_rule_hits,fraud_flags,risk_decisions IN ACCESS EXCLUSIVE MODE',
    );
    const [{ decisions }] = (await queryRunner.query(
      'SELECT count(*)::int AS decisions FROM risk_decisions',
    )) as { decisions: number }[];
    if (decisions !== 0) {
      throw refuse(
        'Refusing to revert risk_decisions: decisions are evidence and the table has rows',
      );
    }
    await queryRunner.query(
      'ALTER TABLE fraud_rule_hits DROP CONSTRAINT fraud_rule_hits_weight_check',
    );
    await queryRunner.query('ALTER TABLE fraud_flags DROP CONSTRAINT fraud_flags_decision_fkey');
    await queryRunner.query('DROP TABLE risk_decisions');
  }
}
