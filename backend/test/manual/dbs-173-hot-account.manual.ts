/**
 * DBS-173 manual test M-173-01: a busy account on a real PostgreSQL, the three queries of DBS-109
 * (kept below, verbatim from commit d6bf542d) against `TransferFacts.accountFacts`, side by side.
 *
 *   DATABASE_URL=postgres://... npm run migration:run   (a throw-away database)
 *   DATABASE_URL=postgres://... npx ts-node -r tsconfig-paths/register test/manual/dbs-173-hot-account.manual.ts
 *
 * The rows are written by "seed SQL" straight into `transfers`, as the `plans` tests of
 * transfer-facts.db-spec do: the fraud queries read only the view `v_transfer_facts`, never the
 * ledger, so no balance is touched. Never run it against a database that holds real data.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { TransferFacts, type Queryable } from '@modules/risk/features/transfer-facts';

const HOT_ROWS = Number(process.env.HOT_ROWS ?? 64_289);
const COMPLETED = `status = 'COMPLETED' AND type = 'TRANSFER'`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LIMIT = 5_000_000n;

const LEGACY_HISTORY = `WITH h AS (
  SELECT amount, row_number() OVER (ORDER BY amount) AS rn, count(*) OVER () AS n
  FROM v_transfer_facts
  WHERE from_account_id = $1 AND ${COMPLETED}
    AND created_at >= $2::timestamptz AND created_at < $3::timestamptz)
SELECT max(n)::int AS n,
       (sum(amount) FILTER (WHERE rn = (n + 1) / 2)
        + sum(amount) FILTER (WHERE rn = (n + 2) / 2))::text AS median2
FROM h`;
const LEGACY_VELOCITY = `SELECT count(*)::int AS hour,
       (count(*) FILTER (WHERE created_at >= $4::timestamptz))::int AS ten,
       COALESCE(bool_or(id = $5::uuid), false) AS current
FROM v_transfer_facts
WHERE from_account_id = $1 AND ${COMPLETED}
  AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`;
const LEGACY_OUTFLOW = `SELECT count(DISTINCT to_account_id)::int AS recipients,
       COALESCE(sum(amount), 0)::text AS total,
       (count(*) FILTER (WHERE amount::numeric * 10 < $4::numeric))::int AS small
FROM v_transfer_facts
WHERE from_account_id = $1 AND ${COMPLETED}
  AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`;

interface PlanNode {
  'Node Type': string;
  'Heap Fetches'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

async function main(): Promise<void> {
  const source = await new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
  }).initialize();
  const q = (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> =>
    source.query<Record<string, unknown>[]>(sql, params);
  const occ = Date.now();
  const iso = (ms: number): string => new Date(ms).toISOString();

  console.log(`seed SQL: ${HOT_ROWS} transfers for one account, plus noise`);
  await q(`INSERT INTO users(id, cognito_sub) VALUES ('11111111-1111-4111-8111-111111111111', 'manual-dbs-173')
           ON CONFLICT DO NOTHING`);
  const accounts: string[] = [];
  for (let i = 0; i < 4; i++) {
    const user = (
      await q(
        `INSERT INTO users(id, cognito_sub) VALUES (gen_random_uuid(), gen_random_uuid()::text) RETURNING id`,
      )
    )[0].id;
    const customer = (
      await q(
        `INSERT INTO customers(user_id, full_name) VALUES ($1, 'Nguyễn Văn An') RETURNING id`,
        [user],
      )
    )[0].id;
    accounts.push(
      String(
        (
          await q(`INSERT INTO accounts(customer_id, type) VALUES ($1, 'CHECKING') RETURNING id`, [
            customer,
          ])
        )[0].id,
      ),
    );
  }
  const [hot, target, other, otherTarget] = accounts;
  await q(
    `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,reject_reason,initiated_by,correlation_id,created_at)
     SELECT 'TRANSFER', $1::uuid, $2::uuid, CASE WHEN g % 3 = 0 THEN 1000 ELSE 1000 + (g * 7919) % 5000000 END,
            'COMPLETED', NULL, '11111111-1111-4111-8111-111111111111', gen_random_uuid(),
            $3::timestamptz - (g * interval '40 milliseconds')
     FROM generate_series(1, $4::int) g`,
    [hot, target, iso(occ), HOT_ROWS],
  );
  await q(
    `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,reject_reason,initiated_by,correlation_id,created_at)
     SELECT 'TRANSFER', $1::uuid, $2::uuid, 1000 + g, 'COMPLETED', NULL,
            '11111111-1111-4111-8111-111111111111', gen_random_uuid(), $3::timestamptz - (g * interval '10 minutes')
     FROM generate_series(1, 2000) g`,
    [other, otherTarget, iso(occ)],
  );
  await q('VACUUM (ANALYZE) transfers');

  const recording: { sql: string; params: unknown[] }[] = [];
  const spy: Queryable = {
    query: async (sql, params) => {
      recording.push({ sql, params: params ?? [] });
      return (await source.query(sql, params)) as unknown;
    },
  };
  const facts = new TransferFacts(spy);
  const current = '00000000-0000-4000-8000-000000000009';
  const fresh = await facts.accountFacts(hot, current, occ, LIMIT);
  const newRecipients = await facts.newRecipientCount(hot, occ);
  const accountSql = recording[0];
  const newRecipientsSql = recording[1];

  const legacy = [
    { name: 'history (old)', sql: LEGACY_HISTORY, params: [hot, iso(occ - 30 * DAY), iso(occ)] },
    {
      name: 'velocity (old)',
      sql: LEGACY_VELOCITY,
      params: [hot, iso(occ - HOUR + 1), iso(occ + 1), iso(occ - 600_000 + 1), current],
    },
    {
      name: 'outflow (old)',
      sql: LEGACY_OUTFLOW,
      params: [hot, iso(occ - DAY + 1), iso(occ + 1), String(LIMIT)],
    },
    { name: 'accountFacts (new)', sql: accountSql.sql, params: accountSql.params },
    { name: 'newRecipientCount', sql: newRecipientsSql.sql, params: newRecipientsSql.params },
  ];
  console.log(
    '\nquery'.padEnd(24),
    'ms'.padStart(8),
    'scans'.padStart(6),
    'heapFetch'.padStart(10),
    'buffers'.padStart(8),
    ' node types',
  );
  let oldMs = 0;
  let newMs = 0;
  for (const item of legacy) {
    const rows = await q(
      `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${item.sql}`,
      item.params,
    );
    const root = (
      rows[0] as unknown as { 'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[] }
    )['QUERY PLAN'][0];
    const nodes = flatten(root.Plan);
    const scans = nodes.filter(
      n => /Scan/.test(n['Node Type']) && !/Subquery|CTE/.test(n['Node Type']),
    );
    const heap = scans.reduce((sum, n) => sum + (n['Heap Fetches'] ?? 0), 0);
    const buffers = (root.Plan['Shared Hit Blocks'] ?? 0) + (root.Plan['Shared Read Blocks'] ?? 0);
    console.log(
      item.name.padEnd(23),
      root['Execution Time'].toFixed(1).padStart(8),
      String(scans.length).padStart(6),
      String(heap).padStart(10),
      String(buffers).padStart(8),
      ' ',
      [...new Set(nodes.map(n => n['Node Type']))].join(', '),
    );
    if (item.name.endsWith('(old)')) oldMs += root['Execution Time'];
    if (item.name.startsWith('accountFacts')) newMs += root['Execution Time'];
  }
  console.log(
    `\nold three together: ${oldMs.toFixed(1)} ms; accountFacts: ${newMs.toFixed(1)} ms; ratio ${(newMs / oldMs).toFixed(2)}`,
  );

  const h = (await q(LEGACY_HISTORY, legacy[0].params))[0];
  const v = (await q(LEGACY_VELOCITY, legacy[1].params))[0];
  const o = (await q(LEGACY_OUTFLOW, legacy[2].params))[0];
  assert.deepEqual(fresh, {
    history: { count: Number(h.n), median2: h.median2 },
    velocity: { hour: v.hour, tenMinutes: v.ten, includesCurrent: v.current },
    outflow: { distinctRecipients: Number(o.recipients), sum: o.total, small: Number(o.small) },
  });
  console.log('same values:', JSON.stringify(fresh), `newRecipients=${newRecipients}`);
  await source.destroy();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
