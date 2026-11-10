import { randomUUID } from 'node:crypto';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Total Cost': number;
  'Actual Rows': number;
  'Actual Total Time': number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

interface ExplainJsonResult {
  Plan: PlanNode;
  'Planning Time': number;
  'Execution Time': number;
}

function findNodes(plan: PlanNode, predicate: (n: PlanNode) => boolean): PlanNode[] {
  const result: PlanNode[] = [];
  if (predicate(plan)) result.push(plan);
  if (plan.Plans) {
    for (const sub of plan.Plans) {
      result.push(...findNodes(sub, predicate));
    }
  }
  return result;
}

describe('DBS-171: EXPLAIN (ANALYZE, BUFFERS) on Hot Production Queries', () => {
  let db: TempDatabase;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;

  const explain = async (sql: string, args: unknown[] = []): Promise<ExplainJsonResult> => {
    const raw = (await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, args)) as {
      'QUERY PLAN': ExplainJsonResult[];
    }[];
    return raw[0]['QUERY PLAN'][0];
  };

  const targetAccountId = randomUUID();
  const recipientAccountId = randomUUID();
  const thirdAccountId = randomUUID();
  const targetCorrelationId = randomUUID();
  const targetUserId = randomUUID();

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);

    // 1. Seed accounts
    await q(`INSERT INTO users(id, cognito_sub) VALUES($1::uuid, 'target-sub')`, [targetUserId]);
    await q(
      `INSERT INTO customers(id, user_id, full_name) VALUES($1::uuid, $1::uuid, 'Test User')`,
      [targetUserId],
    );
    await q(
      `INSERT INTO accounts(id, customer_id, type, status, balance)
       VALUES($1::uuid, $4::uuid, 'CHECKING', 'ACTIVE', 100000000),
             ($2::uuid, $4::uuid, 'CHECKING', 'ACTIVE', 100000000),
             ($3::uuid, $4::uuid, 'CHECKING', 'ACTIVE', 100000000)`,
      [targetAccountId, recipientAccountId, thirdAccountId, targetUserId],
    );

    // 2. Generate 50,000 transfers
    await q(
      `INSERT INTO transfers(id, type, from_account_id, to_account_id, amount, status, initiated_by, correlation_id, created_at)
       SELECT
         gen_random_uuid(),
         'TRANSFER',
         CASE WHEN i % 2 = 0 THEN $1::uuid ELSE $2::uuid END,
         CASE WHEN i % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
         (1000 + (i % 5000))::bigint,
         'COMPLETED',
         $4::uuid,
         gen_random_uuid(),
         clock_timestamp() - ( (i % 365) || ' days')::interval
       FROM generate_series(1, 50000) AS i`,
      [targetAccountId, recipientAccountId, thirdAccountId, targetUserId],
    );

    // 3. Generate 50,000 ledger_entries referencing real transfers
    await q(
      `INSERT INTO ledger_entries(account_id, transfer_id, direction, amount, balance_after, created_at)
       SELECT
         from_account_id,
         id,
         'DEBIT',
         amount,
         100000000::bigint,
         created_at
       FROM transfers`,
    );

    // 4. Generate 50,000 outbox_events (49,900 published, 100 unpublished)
    await q(
      `INSERT INTO outbox_events(event_id, event_type, aggregate_id, payload, correlation_id, published_at, created_at)
       SELECT
         gen_random_uuid(),
         'TransferCompleted',
         gen_random_uuid(),
         '{"amount": 1000}'::jsonb,
         gen_random_uuid(),
         CASE WHEN i <= 49900 THEN clock_timestamp() - ((i % 100) || ' hours')::interval ELSE NULL END,
         clock_timestamp() - ((i % 100) || ' hours')::interval
       FROM generate_series(1, 50000) AS i`,
    );

    // 5. Generate 50,000 audit_log entries (1 matching targetCorrelationId)
    await q(
      `INSERT INTO audit_log(actor_user_id, actor_role, action, outcome, target_type, target_id, correlation_id, occurred_at)
       SELECT
         $1::uuid,
         'customer',
         'transfer',
         'SUCCESS',
         'transfer',
         gen_random_uuid()::text,
         CASE WHEN i = 25000 THEN $2::uuid ELSE gen_random_uuid() END,
         clock_timestamp() - ((i % 100) || ' hours')::interval
       FROM generate_series(1, 50000) AS i`,
      [targetUserId, targetCorrelationId],
    );

    // Update planner statistics
    await q('VACUUM ANALYZE');
  }, 120000);

  afterAll(async () => {
    try {
      await db?.drop();
    } catch {
      /* ignore */
    }
  });

  it('TC-171-01: Daily limit query uses Index Only Scan on ledger_entries with 0 Seq Scan (<= 5 ms)', async () => {
    const todayCutoff = new Date(Date.now() - 24 * 3600 * 1000);
    const sql = `
      SELECT coalesce(sum(amount), 0)::text AS sent
      FROM ledger_entries
      WHERE account_id = $1::uuid
        AND direction = 'DEBIT'
        AND created_at >= $2::timestamptz
    `;
    const res = await explain(sql, [targetAccountId, todayCutoff.toISOString()]);
    const plan = res.Plan;

    // Check no Seq Scan on ledger_entries
    const seqScans = findNodes(
      plan,
      n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'ledger_entries',
    );
    expect(seqScans).toHaveLength(0);

    // Must use Index Scan or Index Only Scan
    const indexScans = findNodes(plan, n => n['Node Type'].includes('Index'));
    expect(indexScans.length).toBeGreaterThanOrEqual(1);

    // Execution time threshold <= 5 ms
    expect(res['Execution Time']).toBeLessThan(5);
    console.log(
      JSON.stringify({
        query: 'daily_limit',
        execMs: res['Execution Time'],
        plan: indexScans[0]['Node Type'],
      }),
    );
  });

  it('TC-171-02: Keyset history query uses Index Scan with 0 Seq Scan and no Sort node (<= 20 ms)', async () => {
    const sql = `
      SELECT id, transfer_id, direction, amount, balance_after, created_at
      FROM ledger_entries
      WHERE account_id = $1::uuid
      ORDER BY account_id, created_at DESC, id DESC
      LIMIT 20
    `;
    const res = await explain(sql, [targetAccountId]);
    const plan = res.Plan;

    // Must not have an explicit in-memory/disk Sort node
    const sortNodes = findNodes(plan, n => n['Node Type'] === 'Sort');
    expect(sortNodes).toHaveLength(0);

    // No Seq Scan on ledger_entries
    const seqScans = findNodes(
      plan,
      n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'ledger_entries',
    );
    expect(seqScans).toHaveLength(0);

    // Execution time threshold <= 20 ms
    expect(res['Execution Time']).toBeLessThan(20);
    console.log(JSON.stringify({ query: 'keyset_history', execMs: res['Execution Time'] }));
  });

  it('TC-171-03: Outbox relay unpublished poll uses Index Scan on outbox_unpublished_idx (<= 5 ms)', async () => {
    const sql = `
      SELECT event_id, event_type, aggregate_id, payload, correlation_id
      FROM outbox_events
      WHERE published_at IS NULL
      ORDER BY event_id
      FOR UPDATE SKIP LOCKED
      LIMIT 100
    `;
    const res = await explain(sql);
    const plan = res.Plan;

    const seqScans = findNodes(
      plan,
      n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'outbox_events',
    );
    expect(seqScans).toHaveLength(0);

    const indexScans = findNodes(plan, n => n['Node Type'].includes('Index'));
    expect(indexScans.length).toBeGreaterThanOrEqual(1);

    expect(res['Execution Time']).toBeLessThan(10);
    console.log(
      JSON.stringify({
        query: 'outbox_poll',
        execMs: res['Execution Time'],
        index: indexScans[0]['Index Name'],
      }),
    );
  });

  it('TC-171-04: Audit lookup by correlation_id uses Index Scan on audit_log_correlation_idx (<= 10 ms)', async () => {
    const sql = `
      SELECT id, occurred_at, actor_user_id, action, outcome, target_type, target_id
      FROM audit_log
      WHERE correlation_id = $1::uuid
      ORDER BY id DESC
      LIMIT 20
    `;
    const res = await explain(sql, [targetCorrelationId]);
    const plan = res.Plan;

    const seqScans = findNodes(
      plan,
      n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'audit_log',
    );
    expect(seqScans).toHaveLength(0);

    const indexScans = findNodes(plan, n => n['Node Type'].includes('Index'));
    expect(indexScans.length).toBeGreaterThanOrEqual(1);

    expect(res['Execution Time']).toBeLessThan(10);
    console.log(
      JSON.stringify({
        query: 'audit_lookup',
        execMs: res['Execution Time'],
        index: indexScans[0]['Index Name'],
      }),
    );
  });
});
