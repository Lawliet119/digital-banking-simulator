import { PENDING_BATCH_SQL } from '@modules/outbox/outbox-relay.service';
import { ROUTED_EVENT_TYPES } from '@modules/outbox/outbox-routing';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/**
 * DBS-171, the hot query no other test explains: the relay's poll of 100 pending events when the
 * table holds hundreds of thousands of published rows (database-design §7: `Index Scan` on
 * `outbox_unpublished_idx`, a few milliseconds). The text is the production constant, not a copy.
 * The other four hot queries are explained, with their own production SQL, by TC-84-01 (daily
 * limit), `transaction-history-plan.db-spec.ts` (first page), TC-109-05 (R1, R2, R4, R5) and
 * TC-103-18 (audit by correlationId).
 */
interface Plan {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Actual Rows': number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: Plan[];
}

const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

describe('DBS-171 the outbox relay poll on a large outbox', () => {
  let db: TempDatabase;
  const PUBLISHED = 400_000;
  const PENDING = 1_000;
  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> =>
    db.runner.query(sql, args) as Promise<T[]>;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    await q(
      `INSERT INTO outbox_events(event_type, aggregate_id, payload, correlation_id, created_at, published_at)
       SELECT 'TransferCompleted', gen_random_uuid(), '{}'::jsonb, gen_random_uuid(),
              clock_timestamp() - make_interval(secs => i),
              CASE WHEN i <= $1::int THEN clock_timestamp() - make_interval(secs => i) END
         FROM generate_series(1, $1::int + $2::int) AS i`,
      [PUBLISHED, PENDING],
    );
    await q('VACUUM (ANALYZE) outbox_events');
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
  });

  async function explain(parked: number[]): Promise<{ plan: Plan; ms: number }> {
    const rows = await q<{ 'QUERY PLAN': { Plan: Plan; 'Execution Time': number }[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${PENDING_BATCH_SQL}`,
      [100, ROUTED_EVENT_TYPES, parked],
    );
    return { plan: rows[0]['QUERY PLAN'][0].Plan, ms: rows[0]['QUERY PLAN'][0]['Execution Time'] };
  }

  it.each([
    ['no parked ids', 0],
    ['50 parked ids after a send failure', 50],
  ])(
    'TC-171-01 the relay poll with %s is an Index Scan on outbox_unpublished_idx, no Seq Scan, no Sort',
    async (_label, parkedCount) => {
      const parked = (
        await q<{ id: string }>(
          'SELECT id FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT $1',
          [parkedCount],
        )
      ).map(row => Number(row.id));
      const runs = [];
      for (let i = 0; i < 5; i++) runs.push(await explain(parked));
      const times = runs.map(run => run.ms).sort((a, b) => a - b);
      const median = times[2];
      const { plan } = runs[4];
      const all = nodes(plan);
      expect(all.filter(n => n['Node Type'] === 'Seq Scan')).toEqual([]);
      expect(all.map(n => n['Node Type'])).not.toContain('Sort');
      const scan = all.find(n => n['Index Name'] === 'outbox_unpublished_idx');
      expect(scan).toBeDefined();
      expect(scan!['Node Type']).toBe('Index Scan');
      // It reads about a batch (plus the parked ones it skips), never the 400,000 published rows.
      expect(scan!['Actual Rows']).toBeLessThanOrEqual(100 + 1);
      const blocks = (scan!['Shared Hit Blocks'] ?? 0) + (scan!['Shared Read Blocks'] ?? 0);
      expect(blocks).toBeLessThan(500);
      // database-design §7: "vài ms". 25 ms leaves a margin for a loaded CI runner.
      expect(median).toBeLessThan(25);
      console.log(
        JSON.stringify({
          query: 'relay_poll',
          parked: parkedCount,
          medianMs: median,
          index: scan!['Index Name'],
          blocks,
          published: PUBLISHED,
        }),
      );
    },
  );
});
