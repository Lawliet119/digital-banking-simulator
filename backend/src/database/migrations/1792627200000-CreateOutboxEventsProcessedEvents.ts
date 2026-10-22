import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOutboxEventsProcessedEvents1792627200000 implements MigrationInterface {
  name = 'CreateOutboxEventsProcessedEvents1792627200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE outbox_events (
        id bigint GENERATED ALWAYS AS IDENTITY,
        event_id uuid NOT NULL DEFAULT gen_random_uuid(),
        event_type text NOT NULL,
        aggregate_id uuid NOT NULL,
        payload jsonb NOT NULL,
        correlation_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        published_at timestamptz,
        CONSTRAINT outbox_events_pkey PRIMARY KEY (id),
        CONSTRAINT outbox_events_event_id_key UNIQUE (event_id)
      )`);
    await queryRunner.query(`
      CREATE TABLE processed_events (
        consumer text NOT NULL,
        event_id uuid NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT processed_events_pkey PRIMARY KEY (consumer, event_id)
      )`);
    // Relay polls pending rows in identity order, without scanning already published events.
    await queryRunner.query(`CREATE INDEX outbox_unpublished_idx
      ON outbox_events (id) WHERE published_at IS NULL`);
    // Cleanup only considers published rows older than the retention window.
    await queryRunner.query(`CREATE INDEX outbox_published_cleanup_idx
      ON outbox_events (published_at) WHERE published_at IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive)
      throw new Error('Reverting outbox requires a transaction');
    // An old REPEATABLE READ snapshot can hide a committed event even after acquiring the lock.
    await queryRunner.query(`DO $$ BEGIN
      IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Reverting outbox requires READ COMMITTED' USING ERRCODE = '55000';
      END IF;
    END $$`);
    await queryRunner.query('LOCK TABLE outbox_events, processed_events IN ACCESS EXCLUSIVE MODE');
    // A separate statement takes a fresh snapshot after all preceding writers have committed.
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM outbox_events) OR EXISTS (SELECT 1 FROM processed_events) THEN
        RAISE EXCEPTION 'Refusing to revert outbox: tables hold data' USING ERRCODE = '55000';
      END IF;
    END $$`);
    await queryRunner.query('DROP TABLE processed_events');
    await queryRunner.query('DROP TABLE outbox_events');
  }
}
