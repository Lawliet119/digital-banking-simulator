import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { OutboxCleanupService } from '@modules/outbox/outbox-cleanup.service';
import { clearOutbox } from '../support/outbox-fixtures';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/**
 * BL-180: "an unpublished outbox row is never deleted" used to hold only because the cleanup
 * query says `published_at IS NOT NULL`, while dbs_worker may DELETE every row. Migration
 * 1795000004000 adds a BEFORE DELETE row trigger, so PostgreSQL itself refuses the delete.
 * Every case here connects as the real dbs_worker LOGIN role (and as the table owner).
 */
describe('outbox_events refuses to delete an unpublished row (BL-180)', () => {
  const PASSWORD = 'outbox-guard-test-only';
  let db: TempDatabase;
  let worker: DataSource;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;
  const asWorker = (sql: string, args: unknown[] = []): Promise<unknown[]> =>
    worker.query(sql, args);

  /** Inserts one row (as the owner) and returns its event_id. */
  async function insert(published: boolean, age = '0 minutes'): Promise<string> {
    const eventId = randomUUID();
    await q(
      `INSERT INTO outbox_events(event_id,event_type,aggregate_id,payload,correlation_id,created_at,published_at)
       VALUES ($1,'TransferCompleted',gen_random_uuid(),'{}'::jsonb,gen_random_uuid(),
               now() - $2::interval, CASE WHEN $3 THEN now() - $2::interval END)`,
      [eventId, age, published],
    );
    return eventId;
  }
  const exists = async (eventId: string): Promise<boolean> =>
    (await q('SELECT 1 FROM outbox_events WHERE event_id=$1', [eventId])).length === 1;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    await db.runner.query(`ALTER ROLE dbs_worker LOGIN PASSWORD '${PASSWORD}'`);
    const url = new URL(db.url);
    url.username = 'dbs_worker';
    url.password = PASSWORD;
    worker = await new DataSource({ type: 'postgres', url: url.toString() }).initialize();
  });
  afterAll(async () => {
    try {
      await worker?.destroy();
    } finally {
      await db?.drop();
    }
  });
  beforeEach(async () => {
    await clearOutbox(q);
  });

  it('TC-180-01 dbs_worker cannot DELETE an unpublished row: SQLSTATE 42501 from the trigger, row stays', async () => {
    const eventId = await insert(false, '400 days');
    await expect(
      asWorker('DELETE FROM outbox_events WHERE event_id=$1', [eventId]),
    ).rejects.toMatchObject({
      code: '42501',
      message: expect.stringMatching(/unpublished.*outbox_events|outbox_events.*unpublished/s),
    });
    expect(await exists(eventId)).toBe(true);
  });

  it('TC-180-02 the refusal comes from the trigger, not from a missing ACL: dbs_worker still holds DELETE', async () => {
    const [{ granted }] = (await q(
      "SELECT has_table_privilege('dbs_worker','public.outbox_events','DELETE') AS granted",
    )) as { granted: boolean }[];
    expect(granted).toBe(true);
    const eventId = await insert(false);
    await expect(
      asWorker('DELETE FROM outbox_events WHERE event_id=$1', [eventId]),
    ).rejects.toThrow(/not allowed/);
  });

  it('TC-180-03 an unfiltered DELETE as dbs_worker fails as a whole: published rows in the same statement stay too', async () => {
    const waiting = await insert(false);
    const sent = await insert(true, '30 days');
    await expect(asWorker('DELETE FROM outbox_events')).rejects.toMatchObject({ code: '42501' });
    expect(await exists(waiting)).toBe(true);
    expect(await exists(sent)).toBe(true);
  });

  it('TC-180-04 the table owner is refused as well: the trigger is not an ACL', async () => {
    const eventId = await insert(false);
    await expect(q('DELETE FROM outbox_events WHERE event_id=$1', [eventId])).rejects.toMatchObject(
      {
        code: '42501',
      },
    );
    expect(await exists(eventId)).toBe(true);
  });

  it('TC-180-05 dbs_worker still deletes a published row (the cleanup job path)', async () => {
    const eventId = await insert(true, '9 days');
    const result = await asWorker('DELETE FROM outbox_events WHERE event_id=$1 RETURNING 1', [
      eventId,
    ]);
    expect(result[0]).toHaveLength(1);
    expect(await exists(eventId)).toBe(false);
  });

  it('TC-180-06 a DELETE that matches no row is not an error', async () => {
    await insert(false);
    const result = await asWorker('DELETE FROM outbox_events WHERE published_at IS NOT NULL');
    expect(result[1]).toBe(0);
  });

  it('TC-180-07 un-publishing a row does not open a way round: the row is unpublished again and cannot be deleted', async () => {
    const eventId = await insert(true, '9 days');
    await asWorker('UPDATE outbox_events SET published_at = NULL WHERE event_id=$1', [eventId]);
    await expect(
      asWorker('DELETE FROM outbox_events WHERE event_id=$1', [eventId]),
    ).rejects.toMatchObject({
      code: '42501',
    });
    expect(await exists(eventId)).toBe(true);
  });

  it('TC-180-08 INSERT and the relay UPDATE of published_at are unaffected', async () => {
    const eventId = await insert(false);
    await asWorker('UPDATE outbox_events SET published_at = clock_timestamp() WHERE event_id=$1', [
      eventId,
    ]);
    const [row] = await q('SELECT published_at FROM outbox_events WHERE event_id=$1', [eventId]);
    expect(row.published_at).not.toBeNull();
  });

  it('TC-180-09 TRUNCATE is not guarded by the row trigger, so it stays closed by privilege: dbs_worker and dbs_api have no TRUNCATE', async () => {
    for (const role of ['dbs_worker', 'dbs_api']) {
      const [{ granted }] = (await q(
        `SELECT has_table_privilege('${role}','public.outbox_events','TRUNCATE') AS granted`,
      )) as { granted: boolean }[];
      expect(granted).toBe(false);
    }
    const eventId = await insert(false);
    await expect(asWorker('TRUNCATE outbox_events')).rejects.toThrow(/permission denied/);
    expect(await exists(eventId)).toBe(true);
  });

  it('TC-180-10 the real OutboxCleanupService, running as dbs_worker, still removes old published rows and keeps unpublished ones', async () => {
    const old = await insert(true, '9 days');
    const fresh = await insert(true, '1 minute');
    const waiting = await insert(false, '400 days');
    const cleanup = new OutboxCleanupService(
      new TransactionService(worker, {
        lockTimeoutMs: 2000,
        statementTimeoutMs: 5000,
        idleInTransactionTimeoutMs: 10000,
      } as never),
      {
        idempotencyKeyRetentionDays: 7,
        outbox: { retentionDays: 7, processedEventsRetentionDays: 7 },
      } as never,
    );
    expect(await cleanup.cleanOnce({ pauseMs: 0 })).toMatchObject({ outbox: 1 });
    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(waiting)).toBe(true);
  });

  it('TC-180-11 the guard is one enabled BEFORE DELETE row trigger on outbox_events (catalog)', async () => {
    const triggers = await q(
      `SELECT t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS def, p.proname
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'public.outbox_events'::regclass AND NOT t.tgisinternal`,
    );
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      tgname: 'outbox_events_no_delete_unpublished',
      tgenabled: 'O',
      proname: 'forbid_delete_unpublished_outbox',
    });
    expect(triggers[0].def).toMatch(/BEFORE DELETE ON public\.outbox_events FOR EACH ROW/);
  });
});
