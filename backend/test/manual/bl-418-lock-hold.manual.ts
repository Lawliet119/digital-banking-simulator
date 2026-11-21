/**
 * BL-418 manual measurement: how long a customer transfer HOLDS the row locks of its two accounts,
 * how long it WAITS for them, and how much of the hold is the daily-limit check.
 *
 *   docker run -d --name bl418-pg -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -p 55418:5432 \
 *     postgres:17 -c shared_preload_libraries=pg_stat_statements
 *   DATABASE_URL=postgres://test:test@localhost:55418/postgres HOT_DEBITS=20000 RATE=24 SECONDS=60 \
 *     npx ts-node -r tsconfig-paths/register test/manual/bl-418-lock-hold.manual.ts
 *
 * Everything is measured inside the real application (HTTP -> Nest -> TransactionService ->
 * PostgreSQL), nothing is mocked. Three numbers per transfer, taken by wrapping the real methods:
 *   wait  = AccountsService.lockForUpdate (the SELECT ... FOR UPDATE, queueing included)
 *   hold  = from the moment lockForUpdate returned until TransactionService.run returned (COMMIT done)
 *   guard = SyncGuardService.checkGuards, which runs inside the hold
 * `HOT_DEBITS` rows of today's debits per account are written by "seed SQL" (a measurement
 * database only: it is dropped at the end and its ledger is NOT balanced) so the cost of the
 * day total can be seen as a busy day grows. A second pass sends transfers through the API with
 * the rows in place. The per-day limit is raised for the run, so the daily total never refuses.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { EntityManager, QueryRunner } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { AccountsService } from '@modules/accounts';
import { SyncGuardService } from '@modules/ledger';
import { createTempDatabase, migrate } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';

const HOT_DEBITS = Number(process.env.HOT_DEBITS ?? 0);
const RATE = Number(process.env.RATE ?? 24);
const SECONDS = Number(process.env.SECONDS ?? 60);
const ACCOUNTS = Number(process.env.ACCOUNTS ?? 3);
const POOL = Number(process.env.POOL ?? 10);

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const summary = (label: string, xs: number[]): string =>
  `${label.padEnd(26)} n=${String(xs.length).padStart(6)}  mean ${(
    xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)
  ).toFixed(2)} ms  p50 ${pct(xs, 50).toFixed(2)}  p95 ${pct(xs, 95).toFixed(2)}  p99 ${pct(
    xs,
    99,
  ).toFixed(2)}  max ${pct(xs, 100).toFixed(2)}`;

async function main(): Promise<void> {
  const db = await createTempDatabase();
  await migrate(db.url);
  const app = await startDepositApp(db.url, { poolMax: POOL });
  try {
    await db.runner.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    app.limits.transfer.perTx = 50_000_000n;
    app.limits.transfer.perDay = 10n ** 15n;
    const operator = await app.issuer.token('operator', { sub: randomUUID() });
    const rows: Awaited<ReturnType<typeof seedDepositTarget>>[] = [];
    for (let i = 0; i < ACCOUNTS; i++) rows.push(await seedDepositTarget(db.runner));
    for (const r of rows) {
      const res = await fetch(`${app.url}/v1/operator/deposits`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${operator}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify({ toAccountId: r.accountId, amount: '1000000000000' }),
      });
      if (res.status !== 201) throw new Error(`deposit failed: ${res.status}`);
    }
    if (HOT_DEBITS > 0) {
      // seed SQL: today's DEBIT lines of every account (each with the transfer the ledger needs).
      for (const r of rows) {
        await db.runner.query(
          `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id,created_at)
           SELECT 'TRANSFER', $1::uuid, $2::uuid, 1000, 'COMPLETED', $3::uuid, gen_random_uuid(),
                  now() - (g * interval '1 second' * 3600 / $4::numeric) FROM generate_series(1,$4::int) g`,
          [r.accountId, rows[(rows.indexOf(r) + 1) % rows.length].accountId, r.userId, HOT_DEBITS],
        );
      }
      await db.runner.query(
        `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after,created_at)
         SELECT t.id, t.from_account_id, 'DEBIT', t.amount, 0, t.created_at FROM transfers t
         WHERE t.status='COMPLETED' AND t.type='TRANSFER'
           AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transfer_id=t.id)`,
      );
    }
    await db.runner.query('VACUUM (ANALYZE) ledger_entries');
    await db.runner.query('VACUUM (ANALYZE) accounts');

    const accounts = app.app.get(AccountsService, { strict: false });
    const guard = app.app.get(SyncGuardService, { strict: false });
    const tx = app.app.get(TransactionService, { strict: false });
    const lockEnd = new WeakMap<QueryRunner, number>();
    const waits: number[] = [],
      holds: number[] = [],
      guards: number[] = [];
    const origLock = accounts.lockForUpdate.bind(accounts);
    accounts.lockForUpdate = async (ids: string[], manager: EntityManager) => {
      const t0 = performance.now();
      const out = await origLock(ids, manager);
      const t1 = performance.now();
      lockEnd.set(manager.queryRunner!, t1);
      waits.push(t1 - t0);
      return out;
    };
    const origGuard = guard.checkGuards.bind(guard);
    guard.checkGuards = async (...args: Parameters<typeof origGuard>) => {
      const t0 = performance.now();
      try {
        return await origGuard(...args);
      } finally {
        guards.push(performance.now() - t0);
      }
    };
    const origRun = tx.run.bind(tx);
    (tx as unknown as { run: unknown }).run = async (
      fn: (m: EntityManager) => Promise<unknown>,
      options?: unknown,
    ) => {
      let runner: QueryRunner | undefined;
      const result = await origRun(async m => {
        runner = m.queryRunner!;
        return fn(m);
      }, options as never);
      const end = performance.now();
      const locked = runner && lockEnd.get(runner);
      if (locked !== undefined) holds.push(end - locked);
      return result;
    };

    const tokens = await Promise.all(rows.map(r => app.issuer.token('customer', { sub: r.sub })));
    await db.runner.query('SELECT pg_stat_statements_reset()');
    const latencies: number[] = [];
    let failures = 0,
      sent = 0;
    const inflight = new Set<Promise<void>>();
    const send = async (): Promise<void> => {
      const from = Math.floor(Math.random() * ACCOUNTS);
      let to = Math.floor(Math.random() * (ACCOUNTS - 1));
      if (to >= from) to++;
      const t0 = performance.now();
      try {
        const res = await fetch(`${app.url}/v1/transfers`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tokens[from]}`,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
          body: JSON.stringify({
            fromAccountId: rows[from].accountId,
            toAccountId: rows[to].accountId,
            amount: String(1000 + Math.floor(Math.random() * 50_000)),
          }),
        });
        await res.text();
        if (res.status !== 201) failures++;
      } catch {
        failures++;
      }
      latencies.push(performance.now() - t0);
    };
    const t0 = performance.now();
    const total = RATE * SECONDS;
    for (let i = 0; i < total; i++) {
      const due = t0 + (i * 1000) / RATE;
      const wait = due - performance.now();
      if (wait > 1) await new Promise(r => setTimeout(r, wait));
      const p = send().finally(() => inflight.delete(p));
      inflight.add(p);
      sent++;
    }
    await Promise.all(inflight);
    const elapsed = (performance.now() - t0) / 1000;

    console.log(
      `\nBL-418 lock hold · accounts=${ACCOUNTS} rate=${RATE}/s seconds=${SECONDS} pool=${POOL} seeded today's debits per account=${HOT_DEBITS}`,
    );
    console.log(`sent ${sent} in ${elapsed.toFixed(1)} s, non-201: ${failures}`);
    console.log(summary('HTTP latency', latencies));
    console.log(summary('lock wait (FOR UPDATE)', waits));
    console.log(summary('lock hold (to COMMIT)', holds));
    console.log(summary('  of which checkGuards', guards));
    const stats = await db.runner.query(
      `SELECT calls::int AS calls, round(mean_exec_time::numeric,3) AS mean_ms,
              round(total_exec_time::numeric,0) AS total_ms, shared_blks_hit/greatest(calls,1) AS buf,
              left(translate(query, chr(10), ' '), 78) AS q
       FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
         AND (query ILIKE '%ledger_entries%' OR query ILIKE '%UPDATE accounts%' OR query ILIKE '%FOR UPDATE%'
              OR query ILIKE '%INSERT INTO transfers%' OR query ILIKE '%idempotency_keys%'
              OR query ILIKE '%outbox_events%' OR query ILIKE '%audit_log%' OR query ILIKE 'COMMIT%')
         AND query NOT ILIKE '%pg_stat_statements%'
       ORDER BY total_exec_time DESC LIMIT 14`,
    );
    console.log('\npg_stat_statements (server side, this run only):');
    for (const s of stats) {
      console.log(
        `  ${String(s.calls).padStart(6)} calls  mean ${String(s.mean_ms).padStart(8)} ms  ${String(
          s.buf,
        ).padStart(6)} buf  ${s.q}`,
      );
    }
  } finally {
    await app.close();
    await db.drop();
  }
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
