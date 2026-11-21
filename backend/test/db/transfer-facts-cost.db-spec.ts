import { DataSource } from 'typeorm';
import { TransferFacts, type Queryable } from '@modules/risk/features/transfer-facts';
import { TransferFixture } from '../support/transfer-facts-fixture';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/**
 * DBS-173: the cost of the worker's feature queries (BL-413). The rewrites of `history`, `velocity`
 * and `outflow` must return exactly what the SQL of DBS-109 returned, so that SQL is kept here as
 * the oracle (LEGACY_*), next to a median computed in JavaScript, and compared on real PostgreSQL.
 * The plan tests then prove the rewrites are cheaper in the way that matters: no window functions
 * and no heap access on a busy account.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OCC = Date.parse('2026-10-19T03:15:42.123Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (deltaMs: number): string => iso(OCC + deltaMs);

const COMPLETED = `status = 'COMPLETED' AND type = 'TRANSFER'`;

/** The `history` SQL as it was before DBS-173 (two WindowAgg nodes over the sorted window). */
const LEGACY_HISTORY = `WITH h AS (
  SELECT amount, row_number() OVER (ORDER BY amount) AS rn, count(*) OVER () AS n
  FROM v_transfer_facts
  WHERE from_account_id = $1 AND ${COMPLETED}
    AND created_at >= $2::timestamptz AND created_at < $3::timestamptz)
SELECT max(n)::int AS n,
       (sum(amount) FILTER (WHERE rn = (n + 1) / 2)
        + sum(amount) FILTER (WHERE rn = (n + 2) / 2))::text AS median2
FROM h`;

/** The `velocity` SQL as it was before DBS-173 (`bool_or(id = …)` forces a heap read of every row). */
const LEGACY_VELOCITY = `SELECT count(*)::int AS hour,
       (count(*) FILTER (WHERE created_at >= $4::timestamptz))::int AS ten,
       COALESCE(bool_or(id = $5::uuid), false) AS current
FROM v_transfer_facts
WHERE from_account_id = $1 AND ${COMPLETED}
  AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`;

/** The `outflow` SQL as it was before DBS-173 (`count(DISTINCT …)`). */
const LEGACY_OUTFLOW = `SELECT count(DISTINCT to_account_id)::int AS recipients,
       COALESCE(sum(amount), 0)::text AS total,
       (count(*) FILTER (WHERE amount::numeric * 10 < $4::numeric))::int AS small
FROM v_transfer_facts
WHERE from_account_id = $1 AND ${COMPLETED}
  AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`;

/** Deterministic pseudo-random numbers (mulberry32), so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Twice the exact median of `amounts` as a canonical integer string; `null` when empty. */
function median2(amounts: bigint[]): string | null {
  if (amounts.length === 0) return null;
  const sorted = [...amounts].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const n = sorted.length;
  return (sorted[Math.floor((n + 1) / 2) - 1] + sorted[Math.floor((n + 2) / 2) - 1]).toString();
}

interface PlanNode {
  'Node Type': string;
  'Heap Fetches'?: number;
  Plans?: PlanNode[];
}
const flatten = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(flatten)];

describe('TransferFacts cost (real PostgreSQL, DBS-173)', () => {
  let db: TempDatabase;
  let source: DataSource;
  let facts: TransferFacts;
  let fixture: TransferFixture;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    facts = new TransferFacts(source);
    fixture = new TransferFixture(db.runner);
  });
  afterAll(async () => {
    await source?.destroy();
    await db?.drop();
  });

  /** Writes the rows of one scenario: inside the window, and the rows that must never count. */
  async function seed(
    amounts: { amount: bigint; offsetMs: number }[],
  ): Promise<{ from: string; to: string; inWindow: bigint[] }> {
    const [from, to, other] = await fixture.accounts(3);
    for (const row of amounts) {
      await fixture.transfer({
        from,
        to,
        amount: row.amount.toString(),
        at: at(row.offsetMs),
      });
    }
    // Rows that must not count: another account, rejected, deposit, at the event time, after it,
    // and exactly 30 days before (the window is [occ - 30d, occ), so this one is in).
    await fixture.transfer({ from: other, to, amount: '123', at: at(-MIN) });
    await fixture.transfer({ from, to, amount: '456', at: at(-MIN), status: 'REJECTED' });
    await fixture.transfer({ from, to, amount: '789', at: at(-MIN), type: 'DEPOSIT' });
    await fixture.transfer({ from, to, amount: '1000', at: at(0) });
    await fixture.transfer({ from, to, amount: '2000', at: at(5 * MIN) });
    const inWindow = amounts
      .filter(r => r.offsetMs >= -30 * DAY && r.offsetMs < 0)
      .map(r => r.amount);
    return { from, to, inWindow };
  }

  describe('history', () => {
    const scenarios: [string, () => { amount: bigint; offsetMs: number }[]][] = [
      ['no history', () => []],
      ['one row', () => [{ amount: 700n, offsetMs: -MIN }]],
      [
        'two rows (even)',
        () => [
          { amount: 1n, offsetMs: -MIN },
          { amount: 2n, offsetMs: -2 * MIN },
        ],
      ],
      [
        'four rows (below the minimum of five)',
        () => [100n, 200n, 300n, 400n].map((amount, i) => ({ amount, offsetMs: -(i + 1) * MIN })),
      ],
      [
        'five equal rows',
        () =>
          [500n, 500n, 500n, 500n, 500n].map((amount, i) => ({
            amount,
            offsetMs: -(i + 1) * HOUR,
          })),
      ],
      [
        'six rows (even, ties around the middle)',
        () =>
          [100n, 200n, 300n, 300n, 500n, 601n].map((amount, i) => ({
            amount,
            offsetMs: -(i + 1) * DAY,
          })),
      ],
      [
        'amounts near 2^63 (the sum must not overflow bigint)',
        () =>
          Array.from({ length: 6 }, (_, i) => ({
            amount: 9223372036854775807n - BigInt(i % 2),
            offsetMs: -(i + 1) * HOUR,
          })),
      ],
      [
        'window edges: exactly 30 days before is in, one ms earlier and the event time are out',
        () => [
          { amount: 10n, offsetMs: -30 * DAY },
          { amount: 99999n, offsetMs: -30 * DAY - 1 },
          { amount: 20n, offsetMs: -1 },
          { amount: 30n, offsetMs: -2 },
          { amount: 40n, offsetMs: -3 },
        ],
      ],
    ];

    it.each(scenarios)(
      'TC-173-01 %s: same count and median as the legacy SQL and as JavaScript',
      async (_name, rows) => {
        const { from, inWindow } = await seed(rows());
        const result = await facts.history(from, OCC);
        const [legacy] = (await q(LEGACY_HISTORY, [from, iso(OCC - 30 * DAY), iso(OCC)])) as {
          n: number | null;
          median2: string | null;
        }[];
        expect(result.count).toBe(legacy.n === null ? 0 : Number(legacy.n));
        expect(result.median2).toBe(legacy.median2);
        expect(result).toEqual({ count: inWindow.length, median2: median2(inWindow) });
      },
    );

    it('TC-173-01 random sets clustered around the 10 min, 1 h, 24 h and 30 day edges: all eight values equal the three legacy queries', async () => {
      const random = prng(173);
      const edges = [10 * MIN, HOUR, DAY, 30 * DAY];
      for (let round = 0; round < 12; round++) {
        const size = 1 + Math.floor(random() * 300);
        const distinct = 1 + Math.floor(random() * 40);
        const [from, to, to2] = await fixture.accounts(3);
        const rows: { amount: bigint; offsetMs: number }[] = [];
        for (let i = 0; i < size; i++) {
          const edge = edges[Math.floor(random() * edges.length)];
          const jitter = Math.floor(random() * 5) - 2; // -2 .. +2 ms around the edge
          rows.push({
            amount: BigInt(1 + Math.floor(random() * distinct)) * 1000n,
            offsetMs: random() < 0.6 ? -(edge + jitter) : -1 - Math.floor(random() * 29 * DAY),
          });
        }
        const ids: string[] = [];
        for (const row of rows) {
          const target = random() < 0.5 ? to : to2;
          const made = await fixture.transfer({
            from,
            to: target,
            amount: row.amount.toString(),
            at: at(row.offsetMs),
          });
          ids.push(made.id);
        }
        await fixture.transfer({ from, to, amount: '77', at: at(0) }); // at the event time
        const current = ids[Math.floor(random() * ids.length)];
        const limit = 20_000n;
        const result = await facts.accountFacts(from, current, OCC, limit);
        const [h] = (await q(LEGACY_HISTORY, [from, iso(OCC - 30 * DAY), iso(OCC)])) as {
          n: number | null;
          median2: string | null;
        }[];
        const [v] = (await q(LEGACY_VELOCITY, [
          from,
          iso(OCC - HOUR + 1),
          iso(OCC + 1),
          iso(OCC - 600_000 + 1),
          current,
        ])) as { hour: number; ten: number; current: boolean }[];
        const [o] = (await q(LEGACY_OUTFLOW, [
          from,
          iso(OCC - DAY + 1),
          iso(OCC + 1),
          String(limit),
        ])) as { recipients: number; total: string; small: number }[];
        expect([round, result]).toEqual([
          round,
          {
            history: { count: h.n === null ? 0 : Number(h.n), median2: h.median2 },
            velocity: { hour: v.hour, tenMinutes: v.ten, includesCurrent: v.current },
            outflow: {
              distinctRecipients: Number(o.recipients),
              sum: o.total,
              small: Number(o.small),
            },
          },
        ]);
        const inWindow = rows
          .filter(r => r.offsetMs >= -30 * DAY && r.offsetMs < 0)
          .map(r => r.amount);
        expect(result.history.median2).toBe(median2(inWindow));
      }
    });
  });

  describe('velocity', () => {
    it('TC-173-03 same counts and the same includesCurrent as the legacy SQL, at the 1 ms edges', async () => {
      const [from, to] = await fixture.accounts(2);
      const edgeOut = await fixture.transfer({ from, to, at: iso(OCC - HOUR) }); // 1h exactly: out
      const edgeIn = await fixture.transfer({ from, to, at: iso(OCC - HOUR + 1) });
      const ten = await fixture.transfer({ from, to, at: iso(OCC - 10 * MIN + 1) });
      const current = await fixture.transfer({ from, to, at: iso(OCC) });
      const later = await fixture.transfer({ from, to, at: iso(OCC + 1) }); // next ms: out
      await fixture.transfer({ from, to, at: at(-MIN), status: 'REJECTED' });
      const lo = iso(OCC - HOUR + 1);
      const hi = iso(OCC + 1);
      const tenLo = iso(OCC - 600_000 + 1);
      for (const id of [edgeOut.id, edgeIn.id, ten.id, current.id, later.id]) {
        const [legacy] = (await q(LEGACY_VELOCITY, [from, lo, hi, tenLo, id])) as {
          hour: number;
          ten: number;
          current: boolean;
        }[];
        expect(await facts.velocity(from, id, OCC)).toEqual({
          hour: legacy.hour,
          tenMinutes: legacy.ten,
          includesCurrent: legacy.current,
        });
      }
      expect((await facts.velocity(from, current.id, OCC)).includesCurrent).toBe(true);
      expect((await facts.velocity(from, later.id, OCC)).includesCurrent).toBe(false);
      expect((await facts.velocity(from, edgeOut.id, OCC)).includesCurrent).toBe(false);
    });
  });

  describe('outflow24h', () => {
    it('TC-173-04 same recipients, total and small count as the legacy SQL and as JavaScript', async () => {
      const [from, ...others] = await fixture.accounts(6);
      const rows = [
        { to: others[0], amount: 40_000n, offsetMs: -HOUR }, // small: under a tenth of the limit
        { to: others[0], amount: 60_000n, offsetMs: -2 * HOUR },
        { to: others[1], amount: 100_000n, offsetMs: 0 },
        { to: others[2], amount: 1n, offsetMs: -DAY }, // exactly 24h: out
        { to: others[2], amount: 1n, offsetMs: -DAY + 1 },
        { to: others[3], amount: 499_999n, offsetMs: -5 * HOUR },
        { to: others[4], amount: 500_000n, offsetMs: -6 * HOUR },
      ];
      for (const row of rows) {
        await fixture.transfer({
          from,
          to: row.to,
          amount: row.amount.toString(),
          at: at(row.offsetMs),
        });
      }
      const perTxLimit = 5_000_000n;
      const [legacy] = (await q(LEGACY_OUTFLOW, [
        from,
        iso(OCC - DAY + 1),
        iso(OCC + 1),
        String(perTxLimit),
      ])) as { recipients: number; total: string; small: number }[];
      const inside = rows.filter(r => r.offsetMs > -DAY && r.offsetMs <= 0);
      const expected = {
        distinctRecipients: new Set(inside.map(r => r.to)).size,
        sum: inside.reduce((s, r) => s + r.amount, 0n).toString(),
        small: inside.filter(r => r.amount * 10n < perTxLimit).length,
      };
      const result = await facts.outflow24h(from, OCC, perTxLimit);
      expect(result).toEqual(expected);
      expect(result).toEqual({
        distinctRecipients: Number(legacy.recipients),
        sum: legacy.total,
        small: Number(legacy.small),
      });
    });

    it('TC-173-04 no transfers is zero recipients, "0" and zero small', async () => {
      const [from] = await fixture.accounts(1);
      expect(await facts.outflow24h(from, OCC, 500_000n)).toEqual({
        distinctRecipients: 0,
        sum: '0',
        small: 0,
      });
    });
  });

  describe('plans on a busy account', () => {
    const HOT_ROWS = 40_000;
    const LIMIT = 5_000_000n;
    let hot: string;
    let hotTarget: string;
    let currentId: string;

    beforeAll(async () => {
      const senders = await fixture.accounts(300);
      [hot, hotTarget] = await fixture.accounts(2);
      currentId = (await fixture.transfer({ from: hot, to: hotTarget, at: at(-1) })).id;
      // The hot account sends HOT_ROWS transfers in the last two hours (about 5 per second), a
      // third of them equal amounts, the rest spread; the others add noise so the planner has a
      // reason to prefer the index.
      await q(
        `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,reject_reason,initiated_by,correlation_id,created_at)
         SELECT 'TRANSFER', $1::uuid, $2::uuid,
                CASE WHEN g % 3 = 0 THEN 1000 ELSE 1000 + (g * 7919) % 5000000 END,
                'COMPLETED', NULL, (SELECT initiated_by FROM transfers LIMIT 1), gen_random_uuid(),
                $3::timestamptz - (g * interval '180 milliseconds')
         FROM generate_series(1, $4::int) g`,
        [hot, hotTarget, iso(OCC), HOT_ROWS],
      );
      await q(
        `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,reject_reason,initiated_by,correlation_id,created_at)
         SELECT 'TRANSFER', s.id, $2::uuid, 1000 + g, 'COMPLETED', NULL,
                (SELECT initiated_by FROM transfers LIMIT 1), gen_random_uuid(),
                $3::timestamptz - (g * interval '10 minutes')
         FROM unnest($1::uuid[]) AS s(id), generate_series(1, 100) AS g`,
        [senders, hotTarget, iso(OCC)],
      );
      await q('VACUUM (ANALYZE) transfers');
    });

    const explain = async (sql: string, params: unknown[]) => {
      const rows = (await q(`EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${sql}`, params)) as {
        'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[];
      }[];
      const root = rows[0]['QUERY PLAN'][0];
      return { nodes: flatten(root.Plan), ms: root['Execution Time'] };
    };
    /** The SQL and parameters `accountFacts` sends, captured without changing what runs. */
    const captureAccountFacts = async (
      transferId: string,
    ): Promise<{ sql: string; params: unknown[] }> => {
      const seen: { sql: string; params: unknown[] }[] = [];
      const recording: Queryable = {
        query: async (sql, params) => {
          seen.push({ sql, params: params ?? [] });
          return (await source.query(sql, params)) as unknown;
        },
      };
      await new TransferFacts(recording).accountFacts(hot, transferId, OCC, LIMIT);
      expect(seen).toHaveLength(1); // one statement, one round trip
      return seen[0];
    };
    /** The three queries of DBS-109, with the parameters each of them used. */
    const legacyParams = () => ({
      history: [hot, iso(OCC - 30 * DAY), iso(OCC)] as unknown[],
      velocity: (id: string): unknown[] => [
        hot,
        iso(OCC - HOUR + 1),
        iso(OCC + 1),
        iso(OCC - 600_000 + 1),
        id,
      ],
      outflow: [hot, iso(OCC - DAY + 1), iso(OCC + 1), String(LIMIT)] as unknown[],
    });

    it('TC-173-02 accountFacts is ONE index-only scan of transfers: no window function, no sequential scan, no heap fetch', async () => {
      const { sql, params } = await captureAccountFacts(currentId);
      const { nodes } = await explain(sql, params);
      const types = nodes.map(n => n['Node Type']);
      expect(types).not.toContain('WindowAgg');
      expect(types).not.toContain('Seq Scan');
      const onlyScans = nodes.filter(n => n['Node Type'] === 'Index Only Scan');
      expect(onlyScans).toHaveLength(1); // the three legacy queries scanned the account three times
      expect(onlyScans[0]['Heap Fetches']).toBe(0);
    });

    it('TC-173-03 the current-transfer check is a probe of one row by transfer id, whether or not it exists', async () => {
      for (const id of [currentId, '00000000-0000-4000-8000-000000000009']) {
        const { sql, params } = await captureAccountFacts(id);
        const { nodes } = await explain(sql, params);
        const probes = nodes.filter(n => n['Node Type'] === 'Index Scan');
        expect(probes).toHaveLength(1);
        // A unique lookup by id: the primary key or one of the ledger keys that start with `id`;
        // any of them reads one row at most.
        expect(JSON.stringify(probes[0])).toMatch(/transfers_(pkey|ledger_(from|to)_key)/);
      }
    });

    it('TC-173-02 accountFacts takes at most 0.85 of the three legacy queries together, answering the same', async () => {
      const { sql, params } = await captureAccountFacts(currentId);
      const fresh: number[] = [];
      const legacy: number[] = [];
      for (let round = 0; round < 5; round++) {
        // Interleaved, so a noisy neighbour hits both sides alike.
        legacy.push(
          (await explain(LEGACY_HISTORY, legacyParams().history)).ms +
            (await explain(LEGACY_VELOCITY, legacyParams().velocity(currentId))).ms +
            (await explain(LEGACY_OUTFLOW, legacyParams().outflow)).ms,
        );
        fresh.push((await explain(sql, params)).ms);
      }
      const middle = (xs: number[]): number => [...xs].sort((a, b) => a - b)[2];
      expect(middle(fresh) / middle(legacy)).toBeLessThanOrEqual(0.85);

      const result = await facts.accountFacts(hot, currentId, OCC, LIMIT);
      const [h] = (await q(LEGACY_HISTORY, legacyParams().history)) as {
        n: number;
        median2: string;
      }[];
      const [v] = (await q(LEGACY_VELOCITY, legacyParams().velocity(currentId))) as {
        hour: number;
        ten: number;
        current: boolean;
      }[];
      const [o] = (await q(LEGACY_OUTFLOW, legacyParams().outflow)) as {
        recipients: number;
        total: string;
        small: number;
      }[];
      expect(result).toEqual({
        history: { count: Number(h.n), median2: h.median2 },
        velocity: { hour: v.hour, tenMinutes: v.ten, includesCurrent: v.current },
        outflow: { distinctRecipients: Number(o.recipients), sum: o.total, small: Number(o.small) },
      });
    });

    it('TC-173-02 newRecipientCount after VACUUM: no sequential scan and no heap fetch', async () => {
      const seen: { sql: string; params: unknown[] }[] = [];
      const recording: Queryable = {
        query: async (sql, params) => {
          seen.push({ sql, params: params ?? [] });
          return (await source.query(sql, params)) as unknown;
        },
      };
      await new TransferFacts(recording).newRecipientCount(hot, OCC);
      const { nodes } = await explain(seen[0].sql, seen[0].params);
      expect(nodes.map(n => n['Node Type'])).not.toContain('Seq Scan');
      for (const scan of nodes.filter(n => n['Node Type'] === 'Index Only Scan'))
        expect(scan['Heap Fetches']).toBe(0);
    });

    it('TC-173-02 a long history with few recent rows (30,000 rows over 29 days, 50 in the last day) costs at most 1.1 of the legacy queries', async () => {
      const [lazy, lazyTo] = await fixture.accounts(2);
      await q(
        `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,reject_reason,initiated_by,correlation_id,created_at)
         SELECT 'TRANSFER', $1::uuid, $2::uuid, 1000 + (g * 37) % 90000, 'COMPLETED', NULL,
                (SELECT initiated_by FROM transfers LIMIT 1), gen_random_uuid(),
                $3::timestamptz - interval '1 day' - (g * interval '83 seconds')
         FROM generate_series(1, 30000) g`,
        [lazy, lazyTo, iso(OCC)],
      );
      await q(
        `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,reject_reason,initiated_by,correlation_id,created_at)
         SELECT 'TRANSFER', $1::uuid, $2::uuid, 5000 + g, 'COMPLETED', NULL,
                (SELECT initiated_by FROM transfers LIMIT 1), gen_random_uuid(),
                $3::timestamptz - (g * interval '20 minutes')
         FROM generate_series(1, 50) g`,
        [lazy, lazyTo, iso(OCC)],
      );
      await q('VACUUM (ANALYZE) transfers');
      const unknown = '00000000-0000-4000-8000-000000000009';
      const seen: { sql: string; params: unknown[] }[] = [];
      const recording: Queryable = {
        query: async (sql, params) => {
          seen.push({ sql, params: params ?? [] });
          return (await source.query(sql, params)) as unknown;
        },
      };
      await new TransferFacts(recording).accountFacts(lazy, unknown, OCC, LIMIT);
      const fresh: number[] = [];
      const legacy: number[] = [];
      for (let round = 0; round < 5; round++) {
        legacy.push(
          (await explain(LEGACY_HISTORY, [lazy, iso(OCC - 30 * DAY), iso(OCC)])).ms +
            (
              await explain(LEGACY_VELOCITY, [
                lazy,
                iso(OCC - HOUR + 1),
                iso(OCC + 1),
                iso(OCC - 600_000 + 1),
                unknown,
              ])
            ).ms +
            (await explain(LEGACY_OUTFLOW, [lazy, iso(OCC - DAY + 1), iso(OCC + 1), String(LIMIT)]))
              .ms,
        );
        fresh.push((await explain(seen[0].sql, seen[0].params)).ms);
      }
      const middle = (xs: number[]): number => [...xs].sort((x, y) => x - y)[2];
      expect(middle(fresh) / middle(legacy)).toBeLessThanOrEqual(1.1);
    });

    it('TC-173-02 rows added after the last VACUUM (a stale visibility map, as on RDS) give the same answers', async () => {
      const [stale, staleTo] = await fixture.accounts(2);
      await q(
        `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,reject_reason,initiated_by,correlation_id,created_at)
         SELECT 'TRANSFER', $1::uuid, $2::uuid, 1000 + (g * 31) % 9000, 'COMPLETED', NULL,
                (SELECT initiated_by FROM transfers LIMIT 1), gen_random_uuid(),
                $3::timestamptz - (g * interval '1 second')
         FROM generate_series(1, 3000) g`,
        [stale, staleTo, iso(OCC)],
      );
      await q('ANALYZE transfers'); // statistics, but the new pages are not all-visible
      const unknown = '00000000-0000-4000-8000-000000000009';
      const result = await facts.accountFacts(stale, unknown, OCC, LIMIT);
      const [h] = (await q(LEGACY_HISTORY, [stale, iso(OCC - 30 * DAY), iso(OCC)])) as {
        n: number;
        median2: string;
      }[];
      const [o] = (await q(LEGACY_OUTFLOW, [
        stale,
        iso(OCC - DAY + 1),
        iso(OCC + 1),
        String(LIMIT),
      ])) as { recipients: number; total: string; small: number }[];
      expect(result.history).toEqual({ count: Number(h.n), median2: h.median2 });
      expect(result.outflow).toEqual({
        distinctRecipients: Number(o.recipients),
        sum: o.total,
        small: Number(o.small),
      });
    });
  });
});
