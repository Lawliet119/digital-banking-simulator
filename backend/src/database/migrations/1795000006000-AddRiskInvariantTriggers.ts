import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BL-223: the cross-table invariants of ADR-14 that a CHECK on one table cannot hold (FRAUD-API-01
 * §3.8 "Bất biến"), as `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`: they are judged at
 * COMMIT, when the decision, the flag and its hits all exist, so the writer (DBS-111) keeps its
 * order of statements. Each failure is `23514` with the constraint name below.
 *
 *   risk_decisions_completed_transfer  a decision exists only for a COMPLETED TRANSFER
 *   risk_decisions_rule_score_hits     rule_score = sum(fraud_rule_hits.weight) once there is a flag
 *   fraud_flags_score_decision         flag score = rule_score + ai_applied_weight
 *   fraud_flags_level_threshold        MEDIUM from `thresholds.medium`, HIGH from `thresholds.high`
 *                                      of the flag's rule-set version (a flag below medium is refused)
 *
 * The functions are SECURITY DEFINER with a fixed search_path: dbs_worker writes the rows but has
 * no SELECT on `transfers` (matrix §8.1), and the check must read it. They only read, and execute
 * is revoked from PUBLIC (a trigger runs without the invoker holding EXECUTE).
 *
 * Not retroactive: rows committed before this migration are not re-checked. A decision whose total
 * reaches the medium threshold but that has no flag is not refused either (a missing row cannot
 * fire a row trigger); that stays the writer's duty.
 */
const FUNCTIONS = [
  'risk_check_completed_transfer',
  'risk_check_rule_score_hits',
  'risk_check_flag_score',
  'risk_check_flag_level',
] as const;

const TRIGGERS: [name: string, table: string, events: string, fn: (typeof FUNCTIONS)[number]][] = [
  ['risk_decisions_completed_transfer', 'risk_decisions', 'INSERT', FUNCTIONS[0]],
  ['fraud_flags_rule_score_hits', 'fraud_flags', 'INSERT', FUNCTIONS[1]],
  [
    'fraud_rule_hits_rule_score_hits',
    'fraud_rule_hits',
    'INSERT OR UPDATE OR DELETE',
    FUNCTIONS[1],
  ],
  [
    'fraud_flags_score_decision',
    'fraud_flags',
    'INSERT OR UPDATE OF score, rule_set_version',
    FUNCTIONS[2],
  ],
  [
    'fraud_flags_level_threshold',
    'fraud_flags',
    'INSERT OR UPDATE OF score, risk_level, rule_set_version',
    FUNCTIONS[3],
  ],
];

const HEADER = 'LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp';

export class AddRiskInvariantTriggers1795000006000 implements MigrationInterface {
  name = 'AddRiskInvariantTriggers1795000006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'");

    await queryRunner.query(`CREATE FUNCTION public.risk_check_completed_transfer()
      RETURNS trigger ${HEADER} AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM public.transfers t
                        WHERE t.id = NEW.transfer_id AND t.type = 'TRANSFER' AND t.status = 'COMPLETED') THEN
          RAISE EXCEPTION 'risk decision % is not for a COMPLETED TRANSFER', NEW.transfer_id
            USING ERRCODE = '23514', TABLE = 'risk_decisions',
                  CONSTRAINT = 'risk_decisions_completed_transfer';
        END IF;
        RETURN NULL;
      END;
      $$`);

    // Runs from fraud_flags (INSERT) and fraud_rule_hits (INSERT, UPDATE, DELETE): both carry transfer_id.
    await queryRunner.query(`CREATE FUNCTION public.risk_check_rule_score_hits()
      RETURNS trigger ${HEADER} AS $$
      DECLARE
        tid uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.transfer_id ELSE NEW.transfer_id END;
        expected bigint;
        total bigint;
      BEGIN
        SELECT d.rule_score,
               (SELECT COALESCE(sum(h.weight), 0) FROM public.fraud_rule_hits h WHERE h.transfer_id = f.transfer_id)
          INTO expected, total
          FROM public.fraud_flags f
          JOIN public.risk_decisions d ON d.transfer_id = f.transfer_id
         WHERE f.transfer_id = tid;
        IF FOUND AND expected <> total THEN
          RAISE EXCEPTION 'rule_score % of transfer % differs from the sum % of its rule hits', expected, tid, total
            USING ERRCODE = '23514', TABLE = TG_TABLE_NAME,
                  CONSTRAINT = 'risk_decisions_rule_score_hits';
        END IF;
        RETURN NULL;
      END;
      $$`);

    await queryRunner.query(`CREATE FUNCTION public.risk_check_flag_score()
      RETURNS trigger ${HEADER} AS $$
      DECLARE
        expected bigint;
      BEGIN
        SELECT d.rule_score::bigint + d.ai_applied_weight::bigint INTO expected
          FROM public.risk_decisions d WHERE d.transfer_id = NEW.transfer_id;
        IF FOUND AND NEW.score <> expected THEN
          RAISE EXCEPTION 'flag score % of transfer % differs from rule_score + ai_applied_weight = %',
            NEW.score, NEW.transfer_id, expected
            USING ERRCODE = '23514', TABLE = 'fraud_flags',
                  CONSTRAINT = 'fraud_flags_score_decision';
        END IF;
        RETURN NULL;
      END;
      $$`);

    await queryRunner.query(`CREATE FUNCTION public.risk_check_flag_level()
      RETURNS trigger ${HEADER} AS $$
      DECLARE
        cfg jsonb;
        medium numeric;
        high numeric;
        expected text;
      BEGIN
        SELECT s.config INTO cfg FROM public.risk_rule_sets s WHERE s.version = NEW.rule_set_version;
        IF jsonb_typeof(cfg #> '{thresholds,medium}') IS DISTINCT FROM 'number'
           OR jsonb_typeof(cfg #> '{thresholds,high}') IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'rule set % has no numeric thresholds.medium and thresholds.high', NEW.rule_set_version
            USING ERRCODE = '23514', TABLE = 'fraud_flags',
                  CONSTRAINT = 'fraud_flags_level_threshold';
        END IF;
        medium := (cfg #>> '{thresholds,medium}')::numeric;
        high := (cfg #>> '{thresholds,high}')::numeric;
        expected := CASE WHEN NEW.score >= high THEN 'HIGH'
                         WHEN NEW.score >= medium THEN 'MEDIUM'
                         ELSE 'LOW' END;
        IF NEW.risk_level IS DISTINCT FROM expected THEN
          RAISE EXCEPTION 'flag of transfer % has score % and level %, rule set % gives %',
            NEW.transfer_id, NEW.score, NEW.risk_level, NEW.rule_set_version, expected
            USING ERRCODE = '23514', TABLE = 'fraud_flags',
                  CONSTRAINT = 'fraud_flags_level_threshold';
        END IF;
        RETURN NULL;
      END;
      $$`);

    for (const fn of FUNCTIONS) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC`);
    }
    for (const [name, table, events, fn] of TRIGGERS) {
      await queryRunner.query(`CREATE CONSTRAINT TRIGGER ${name}
        AFTER ${events} ON public.${table}
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'");
    for (const [name, table] of TRIGGERS) {
      await queryRunner.query(`DROP TRIGGER ${name} ON public.${table}`);
    }
    for (const fn of FUNCTIONS) {
      await queryRunner.query(`DROP FUNCTION public.${fn}()`);
    }
  }
}
