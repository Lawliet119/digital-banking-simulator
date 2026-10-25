import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuditLog1792627200001 implements MigrationInterface {
  name = 'CreateAuditLog1792627200001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE audit_log (
      id bigint GENERATED ALWAYS AS IDENTITY,
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      actor_user_id uuid,
      actor_role text NOT NULL,
      action text NOT NULL,
      outcome text NOT NULL,
      target_type text NOT NULL,
      target_id text NOT NULL,
      correlation_id uuid NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT audit_log_pkey PRIMARY KEY (id),
      CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id)
        REFERENCES users(id) ON DELETE RESTRICT,
      CONSTRAINT audit_log_outcome_check CHECK (outcome IN ('SUCCESS','REJECTED','DENIED'))
    )`);
    // Correlation is the auditor's primary trace lookup.
    await queryRunner.query('CREATE INDEX audit_log_correlation_idx ON audit_log (correlation_id)');
    // Actor/action searches page newest entries first.
    await queryRunner.query(
      'CREATE INDEX audit_log_actor_occurred_idx ON audit_log (actor_user_id, occurred_at DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX audit_log_action_occurred_idx ON audit_log (action, occurred_at DESC)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) {
      throw Object.assign(new Error('Reverting audit requires a transaction'), { code: '55000' });
    }
    // Locking alone cannot refresh an earlier snapshot in REPEATABLE READ.
    await queryRunner.query(`DO $$ BEGIN
      IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Reverting audit requires READ COMMITTED' USING ERRCODE = '55000';
      END IF;
    END $$`);
    await queryRunner.query('LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE');
    // This statement must run after the lock, with its own READ COMMITTED snapshot.
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM audit_log) THEN
        RAISE EXCEPTION 'Refusing to revert audit: table holds data' USING ERRCODE = '55000';
      END IF;
    END $$`);
    await queryRunner.query('DROP TABLE audit_log');
  }
}
