import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DBS-173 (BL-413): keep the visibility map of `transfers` fresh.
 *
 * `transfers` only ever receives inserts (the append-only triggers refuse UPDATE and DELETE), so
 * autovacuum reaches it through the INSERT threshold: 1,000 rows plus 20% of the table. At the
 * 24 transfers per second of the 120 RPS design load that is a vacuum every five to seven minutes
 * and growing with the table. The fraud feature queries read the last hour, the last 24 hours and
 * the last 30 days of one account through `transfers_account_completed_idx`, which is built for an
 * index-only scan; the pages they need most are the newest ones, the pages no vacuum has marked
 * all-visible yet. Measured on RDS during DBS-173: 85% of the pages in the visibility map, 39% of
 * the rows of a busy account fetched from the heap, and a planner that therefore chose a
 * sequential scan of the whole table (1,008 buffers per query, four queries per transfer). After a
 * manual VACUUM the same queries became index-only scans with no heap fetch and 26 ms instead of
 * 77 ms.
 *
 * Scale factor 0 with a fixed threshold of 1,000 makes autovacuum run after every 1,000 inserts
 * whatever the size of the table (about every one to two minutes at 24 inserts per second;
 * `autovacuum_naptime` of one minute is the floor). An insert-driven vacuum reads only the pages
 * that are not yet all-visible, so it stays cheap on a large table, and an append-only table leaves
 * no dead rows or index entries to clean. The analyze threshold is left alone: nothing measured
 * says the statistics are the problem.
 *
 * Storage parameters only: no data and no schema change, no lock beyond SHARE UPDATE EXCLUSIVE
 * (DML is not blocked). `dbs_migrator` owns the table, so no grant is involved. `RESET` on the way
 * down puts the defaults back (`pg_class.reloptions` becomes NULL).
 */
export class TuneTransfersAutovacuum1795000011000 implements MigrationInterface {
  name = 'TuneTransfersAutovacuum1795000011000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE transfers SET (
         autovacuum_vacuum_insert_scale_factor = 0,
         autovacuum_vacuum_insert_threshold = 1000)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE transfers RESET (
         autovacuum_vacuum_insert_scale_factor,
         autovacuum_vacuum_insert_threshold)`,
    );
  }
}
