import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateReconciliationRuns1793577600000 implements MigrationInterface {
  name = 'CreateReconciliationRuns1793577600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE public.reconciliation_runs (
      id bigint GENERATED ALWAYS AS IDENTITY,
      started_at timestamptz NOT NULL,
      finished_at timestamptz,
      status text NOT NULL,
      total_debit bigint,
      total_credit bigint,
      total_balance bigint,
      mismatched_accounts int NOT NULL DEFAULT 0,
      details jsonb,
      CONSTRAINT reconciliation_runs_pkey PRIMARY KEY (id),
      CONSTRAINT reconciliation_runs_status_check CHECK (status IN ('OK','MISMATCH','ERROR')),
      CONSTRAINT reconciliation_runs_details_check CHECK (details IS NULL OR ((
        jsonb_typeof(details) = 'array'
        AND jsonb_path_query_array(details, 'strict $[*] ? (
          @.type() == "object"
          && exists (@.accountId ? (
            @.type() == "string"
            && @ like_regex "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"))
          && exists (@.balance ? (
            @.type() == "string" && @ like_regex "^(0|-?[1-9][0-9]{0,18})$"
            && @.bigint().string() == @))
          && exists (@.ledgerBalance ? (
            @.type() == "string" && @ like_regex "^(0|-?[1-9][0-9]{0,18})$"
            && @.bigint().string() == @))
          && !exists (@.keyvalue() ? (
            @.key != "accountId" && @.key != "balance" && @.key != "ledgerBalance"))
        )'::jsonpath, '{}'::jsonb, true) = details
      ) IS TRUE))
    )`);
    // Only complete valid elements survive the filter. IS TRUE also rejects SQL/JSON unknowns;
    // integer strings avoid a producer losing precision before PostgreSQL receives the JSON.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) {
      throw Object.assign(new Error('Reverting reconciliation requires a transaction'), {
        code: '55000',
      });
    }
    await queryRunner.query(`DO $$ BEGIN
      IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Reverting reconciliation requires READ COMMITTED' USING ERRCODE = '55000';
      END IF;
    END $$`);
    await queryRunner.query('LOCK TABLE public.reconciliation_runs IN ACCESS EXCLUSIVE MODE');
    // A separate READ COMMITTED statement sees a writer that committed while the lock waited.
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM public.reconciliation_runs) THEN
        RAISE EXCEPTION 'Refusing to revert reconciliation: table holds data' USING ERRCODE = '55000';
      END IF;
    END $$`);
    await queryRunner.query('DROP TABLE public.reconciliation_runs');
  }
}
