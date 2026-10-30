import type { MigrationInterface, QueryRunner } from 'typeorm';

// Historical seed: changing these values requires a new immutable rule-set version, not editing v1.
const V1_CONFIG = {
  mode: 'rule_only',
  thresholds: { medium: 40, high: 70 },
  rules: {
    R1: { enabled: true, weight: 30, maxTransfers: 5, windowMinutes: 10 },
    R2: { enabled: true, weight: 25, medianMultiplier: 5, historyDays: 30, minHistory: 5 },
    R3: {
      enabled: true,
      weight: 35,
      maxAccountAgeHoursExclusive: 24,
      minAmountExclusive: '10000000',
    },
    R4: { enabled: true, weight: 20, reverseWindowMinutes: 60 },
    R5: {
      enabled: true,
      weight: 40,
      minNewRecipients: 5,
      windowMinutes: 60,
      noveltyDays: 30,
      sameOwnerExempt: true,
    },
    R6: {
      enabled: true,
      weight: 30,
      minBalancePercent: 90,
      minBalance: '1000000',
      sameOwnerExempt: true,
    },
  },
  ml: { enabled: false },
};

export class CreateFraudStorage1792713600000 implements MigrationInterface {
  name = 'CreateFraudStorage1792713600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE risk_rule_sets (
      version int NOT NULL,
      config jsonb NOT NULL,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT risk_rule_sets_pkey PRIMARY KEY (version),
      CONSTRAINT risk_rule_sets_created_by_fkey FOREIGN KEY (created_by)
        REFERENCES users(id) ON DELETE RESTRICT
    )`);
    await queryRunner.query(
      'INSERT INTO risk_rule_sets(version,config,created_by) VALUES(1,$1::jsonb,NULL)',
      [JSON.stringify(V1_CONFIG)],
    );

    await queryRunner.query(`CREATE TABLE fraud_flags (
      transfer_id uuid NOT NULL,
      score int NOT NULL,
      risk_level text NOT NULL,
      rule_set_version int NOT NULL,
      review_status text NOT NULL DEFAULT 'OPEN',
      reviewed_by uuid,
      reviewed_at timestamptz,
      review_note text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT fraud_flags_pkey PRIMARY KEY (transfer_id),
      CONSTRAINT fraud_flags_transfer_id_fkey FOREIGN KEY (transfer_id)
        REFERENCES transfers(id) ON DELETE RESTRICT,
      CONSTRAINT fraud_flags_rule_set_version_fkey FOREIGN KEY (rule_set_version)
        REFERENCES risk_rule_sets(version) ON DELETE RESTRICT,
      CONSTRAINT fraud_flags_reviewed_by_fkey FOREIGN KEY (reviewed_by)
        REFERENCES users(id) ON DELETE RESTRICT,
      CONSTRAINT fraud_flags_score_check CHECK (score >= 0),
      CONSTRAINT fraud_flags_risk_level_check CHECK (risk_level IN ('MEDIUM','HIGH')),
      CONSTRAINT fraud_flags_review_status_check CHECK
        (review_status IN ('OPEN','CONFIRMED_FRAUD','FALSE_POSITIVE')),
      CONSTRAINT fraud_flags_review_consistent CHECK (
        (review_status = 'OPEN' AND reviewed_by IS NULL AND reviewed_at IS NULL)
        OR
        (review_status <> 'OPEN' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
      )
    )`);

    await queryRunner.query(`CREATE TABLE fraud_rule_hits (
      transfer_id uuid NOT NULL,
      rule_id text NOT NULL,
      weight int NOT NULL,
      explanation text NOT NULL,
      CONSTRAINT fraud_rule_hits_pkey PRIMARY KEY (transfer_id,rule_id),
      CONSTRAINT fraud_rule_hits_transfer_id_fkey FOREIGN KEY (transfer_id)
        REFERENCES fraud_flags(transfer_id) ON DELETE RESTRICT,
      CONSTRAINT fraud_rule_hits_rule_id_check CHECK (rule_id IN ('R1','R2','R3','R4','R5','R6'))
    )`);

    // UC-10 pages the open queue by risk level and newest creation time.
    await queryRunner.query(`CREATE INDEX fraud_flags_open_queue_idx
      ON fraud_flags (risk_level,created_at DESC) WHERE review_status = 'OPEN'`);
    await queryRunner.query(`CREATE TRIGGER risk_rule_sets_append_only
      BEFORE UPDATE OR DELETE ON public.risk_rule_sets
      FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation()`);
    await queryRunner.query(`CREATE TRIGGER risk_rule_sets_no_truncate
      BEFORE TRUNCATE ON public.risk_rule_sets
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) {
      throw Object.assign(new Error('Refusing to revert fraud outside a transaction'), {
        code: '55000',
      });
    }
    const [{ isolation }] = (await queryRunner.query(
      "SELECT current_setting('transaction_isolation') AS isolation",
    )) as { isolation: string }[];
    if (isolation !== 'read committed') {
      throw Object.assign(new Error('Refusing to revert fraud without READ COMMITTED'), {
        code: '55000',
      });
    }
    // The next statement observes rows committed before these exclusive locks were acquired.
    await queryRunner.query(
      'LOCK TABLE fraud_rule_hits,fraud_flags,risk_rule_sets IN ACCESS EXCLUSIVE MODE',
    );
    const [{ flags, hits }] = (await queryRunner.query(`SELECT
      (SELECT count(*) FROM fraud_flags) AS flags,
      (SELECT count(*) FROM fraud_rule_hits) AS hits`)) as { flags: string; hits: string }[];
    const ruleSets = (await queryRunner.query(
      'SELECT version,created_by,config=$1::jsonb AS unchanged FROM risk_rule_sets',
      [JSON.stringify(V1_CONFIG)],
    )) as { version: number; created_by: string | null; unchanged: boolean }[];
    if (
      flags !== '0' ||
      hits !== '0' ||
      ruleSets.length !== 1 ||
      ruleSets[0].version !== 1 ||
      ruleSets[0].created_by !== null ||
      ruleSets[0].unchanged !== true
    ) {
      throw Object.assign(
        new Error('Refusing to revert fraud: tables hold data or seed v1 changed'),
        {
          code: '55000',
        },
      );
    }
    await queryRunner.query('DROP TABLE fraud_rule_hits');
    await queryRunner.query('DROP TABLE fraud_flags');
    await queryRunner.query('DROP TRIGGER risk_rule_sets_append_only ON public.risk_rule_sets');
    await queryRunner.query('DROP TRIGGER risk_rule_sets_no_truncate ON public.risk_rule_sets');
    await queryRunner.query('DROP TABLE risk_rule_sets');
  }
}
