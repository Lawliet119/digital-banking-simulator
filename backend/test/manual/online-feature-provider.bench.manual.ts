// Micro-benchmark of OnlineFeatureProvider.extract on a hot account (BL-187). LOCAL numbers only:
// Testcontainers PostgreSQL 17 on the developer's machine, no network, no RDS, no other load.
//   cd backend && npx ts-node -r tsconfig-paths/register test/manual/online-feature-provider.bench.manual.ts
// Env: BENCH_HOT_LAST_HOUR (default 18000 = 20 transfers/s for 15 min), BENCH_HOT_HISTORY (50000),
//      BENCH_RATE (120 extractions/s), BENCH_SECONDS (20), BENCH_SERIAL (300), BENCH_POOL (10), BENCH_ROUNDS (2).
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DataSource } from 'typeorm';
import type { TransferEvent } from '@modules/risk/features/feature-provider';
import { OnlineFeatureProvider } from '@modules/risk/features/online-feature-provider';
import { TransferFacts } from '@modules/risk/features/transfer-facts';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import { TransferFixture } from '../support/transfer-facts-fixture';
import { startPostgresContainer, stopPostgresContainer } from '../support/postgres.container';
import { createTempDatabase, migrate } from '../support/temp-database';

const num = (name: string, fallback: number): number => Number(process.env[name] ?? fallback);
const HOT_LAST_HOUR = num('BENCH_HOT_LAST_HOUR', 18_000);
const HOT_HISTORY = num('BENCH_HOT_HISTORY', 50_000);
const RATE = num('BENCH_RATE', 120);
const SECONDS = num('BENCH_SECONDS', 20);
const SERIAL = num('BENCH_SERIAL', 300);
const POOL = num('BENCH_POOL', 10);
const ROUNDS = num('BENCH_ROUNDS', 2);
const RECIPIENTS = 200;
const BASE = Date.parse('2026-11-09T03:00:00.000Z');

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const summary = (ms: number[]) => {
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: +pct(sorted, 50).toFixed(2),
    p95: +pct(sorted, 95).toFixed(2),
    p99: +pct(sorted, 99).toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
  };
};

async function main(): Promise<void> {
  process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
  const db = await createTempDatabase();
  let source: DataSource | undefined;
  try {
    await migrate(db.url);
    const fixture = new TransferFixture(db.runner);
    const accounts = await fixture.accounts(RECIPIENTS + 2);
    const [hot, ...recipients] = accounts;
    const quiet = recipients[0];
    const actor = (await db.runner.query(`SELECT id FROM users LIMIT 1`)) as { id: string }[];
    // Bulk rows through SQL: the hot account's last hour (R1/R5/R6 windows) and 30 days of history.
    const bulk = (count: number, fromMs: number, toMs: number) =>
      db.runner.query(
        `INSERT INTO transfers(type, from_account_id, to_account_id, amount, status, initiated_by, correlation_id, created_at)
         SELECT 'TRANSFER', $1, ($2::uuid[])[1 + (g % $3)], (10000 + (g % 50) * 1000)::bigint, 'COMPLETED', $4,
                gen_random_uuid(), to_timestamp(($5::bigint + (g * ($6::bigint - $5::bigint)) / $7) / 1000.0)
         FROM generate_series(0, $7 - 1) g`,
        [hot, recipients, RECIPIENTS, actor[0].id, fromMs, toMs, count],
      );
    await bulk(HOT_LAST_HOUR, BASE - 3_600_000 + 1_000, BASE - 1_000);
    await bulk(HOT_HISTORY, BASE - 29 * 86_400_000, BASE - 3_600_000 - 1_000);
    await db.runner.query('ANALYZE transfers');
    const current = await fixture.transfer({
      from: hot,
      to: recipients[1],
      at: new Date(BASE).toISOString(),
    });
    const event = {
      ...TRANSFER_SAMPLE,
      eventId: current.id,
      transferId: current.id,
      fromAccountId: hot,
      toAccountId: recipients[1],
      occurredAt: new Date(BASE).toISOString(),
    } as TransferEvent;

    source = await new DataSource({
      type: 'postgres',
      url: db.url,
      extra: { max: POOL },
    }).initialize();
    const facts = new TransferFacts(source);
    const snapshotProvider = new OnlineFeatureProvider({ facts, perTxLimit: 500_000n });
    // The extraction as it was before BL-187: five autocommitted statements, five pooled connections.
    const legacy = async (e: TransferEvent) => {
      const occ = Date.parse(e.occurredAt);
      return Promise.all([
        facts.velocity(e.fromAccountId, e.transferId, occ),
        facts.newRecipientCount(e.fromAccountId, occ),
        facts.history(e.fromAccountId, occ),
        facts.reverseTransfer(e.fromAccountId, e.toAccountId, occ),
        facts.outflow24h(e.fromAccountId, occ, 500_000n),
      ]);
    };
    const snapshot = (e: TransferEvent) => snapshotProvider.extract(e);

    const features = await snapshot(event);
    assert.ok(features.txCount1h >= HOT_LAST_HOUR, 'the hot account must carry its hour of facts');
    const [velocity, , history] = await legacy(event);
    assert.equal(velocity.hour, features.txCount1h);
    assert.equal(history.count, features.historyCount30d);
    console.log(
      `rows: hot account ${HOT_LAST_HOUR} in the last hour + ${HOT_HISTORY} in the 30 days before; ` +
        `txCount1h=${features.txCount1h} historyCount30d=${features.historyCount30d} ` +
        `distinctRecipients24h=${features.distinctRecipients24h}; pool max ${POOL}`,
    );

    // Statements per extraction: the same two providers over a Queryable that counts what it sends.
    const counts: Record<string, number> = {};
    for (const name of ['legacy', 'snapshot'] as const) {
      let sent = 0;
      const ds = source;
      const counting = {
        query: (sql: string, params?: unknown[]) => {
          sent++;
          return ds.query(sql, params);
        },
        createQueryRunner: () => {
          const runner = ds.createQueryRunner();
          const run = runner.query.bind(runner);
          runner.query = ((sql: string, params?: unknown[]) => {
            sent++;
            return run(sql, params);
          }) as typeof runner.query;
          return runner;
        },
      };
      const probe = new TransferFacts(counting);
      if (name === 'legacy') {
        const occ = Date.parse(event.occurredAt);
        await Promise.all([
          probe.velocity(hot, event.transferId, occ),
          probe.newRecipientCount(hot, occ),
          probe.history(hot, occ),
          probe.reverseTransfer(hot, recipients[1], occ),
          probe.outflow24h(hot, occ, 500_000n),
        ]);
      } else {
        await new OnlineFeatureProvider({ facts: probe, perTxLimit: 500_000n }).extract(event);
      }
      counts[name] = sent;
    }
    console.log('SQL statements sent per extraction:', counts);

    // Rounds alternate legacy/snapshot so a slow host minute does not favour one variant.
    const variants = [
      ['legacy', legacy],
      ['snapshot', snapshot],
    ] as const;
    for (const [name, run] of Array.from({ length: ROUNDS }, () => variants).flat()) {
      const warm = await Promise.all(Array.from({ length: 30 }, () => run(event)));
      void warm;
      const serial: number[] = [];
      for (let i = 0; i < SERIAL; i++) {
        const t = performance.now();
        await run(event);
        serial.push(performance.now() - t);
      }
      // Open loop at RATE extractions/s: arrivals do not wait for completions (queueing shows up).
      const open: number[] = [];
      const inflight: Promise<void>[] = [];
      const started = performance.now();
      const total = RATE * SECONDS;
      for (let i = 0; i < total; i++) {
        const due = started + (i * 1000) / RATE;
        const wait = due - performance.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        const t = performance.now();
        inflight.push(run(event).then(() => void open.push(performance.now() - t)));
      }
      await Promise.all(inflight);
      console.log(
        `${name.padEnd(8)} serial  ms ${JSON.stringify(summary(serial))}\n` +
          `${name.padEnd(8)} ${RATE}/s  ms ${JSON.stringify(summary(open))}`,
      );
    }

    const quietEvent = { ...event, fromAccountId: quiet, transferId: current.id };
    const q: number[] = [];
    for (let i = 0; i < SERIAL; i++) {
      const t = performance.now();
      await snapshot(quietEvent);
      q.push(performance.now() - t);
    }
    console.log(`snapshot quiet account serial ms ${JSON.stringify(summary(q))}`);
  } finally {
    try {
      if (source?.isInitialized) await source.destroy();
    } finally {
      try {
        await db.drop();
      } finally {
        await stopPostgresContainer();
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error('FAILED', error);
  process.exitCode = 1;
});
