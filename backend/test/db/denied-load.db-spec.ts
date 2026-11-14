import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { startDepositApp, type DepositApp } from '../support/deposit-app';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

type Row = Record<string, unknown>;

/**
 * BL-019: load on the connection pool of `AuditService.recordDenied` when `RolesGuard` answers
 * many 403 at once. Each refusal writes its own transaction (no business transaction to join), so
 * the question is whether a burst of refusals can hold more connections than the pool has, starve
 * the business routes, or fail with a pool timeout instead of a clean 403.
 *
 * The run uses the real app and PostgreSQL, the production pool size (`DATABASE_POOL_MAX`
 * defaults to 10) and a 1 s acquire timeout (stricter than the 5 s of `database.module.ts`). It
 * samples `pg_stat_activity` and the pg pool every few ms. The numbers go to stdout so they can be
 * copied into docs/features/DBS-56-audit-service-record.md section 8; the assertions only hold
 * the invariants that must never change: every refusal is a 403 with exactly one DENIED row, the
 * app never holds more connections than the pool allows, and no connection is left open or idle
 * in a transaction afterwards.
 */
const REQUESTS = 200;
const CONCURRENCY = 20;
const POOL_MAX = 10;

interface Sample {
  server: number;
  active: number;
  idleInTx: number;
  poolTotal: number;
  poolWaiting: number;
}

describe('BL-019 recordDenied under repeated 403', () => {
  let db: TempDatabase;
  let app: DepositApp;
  const q = (sql: string, args: unknown[] = []): Promise<Row[]> =>
    db.runner.query(sql, args) as Promise<Row[]>;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, { audit: true, poolMax: POOL_MAX });
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  /** `db.runner` is the sampler and the seeder: its own backend is excluded from every count. */
  const appConnections = async (): Promise<Pick<Sample, 'server' | 'active' | 'idleInTx'>> => {
    const [row] = await q(
      `SELECT count(*)::int AS server,
              count(*) FILTER (WHERE state = 'active')::int AS active,
              count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idle_in_tx
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    return {
      server: Number(row.server),
      active: Number(row.active),
      idleInTx: Number(row.idle_in_tx),
    };
  };
  const pool = (): { totalCount: number; waitingCount: number } =>
    (app.source.driver as unknown as { master: { totalCount: number; waitingCount: number } })
      .master;

  it('TC-19-01 200 refusals at concurrency 20: all 403, one DENIED row each, pool never exceeded, nothing left open', async () => {
    const auditor = await app.issuer.token('auditor', { sub: randomUUID() });
    // Warm up: the first request creates the users row and the JWKS cache, not part of the load.
    await request(app.url)
      .post('/v1/operator/deposits')
      .auth(auditor, { type: 'bearer' })
      .send({})
      .expect(403);
    const [{ n: before }] = await q(`SELECT count(*)::int AS n FROM audit_log`);

    const samples: Sample[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const counts = await appConnections();
        samples.push({
          ...counts,
          poolTotal: pool().totalCount,
          poolWaiting: pool().waitingCount,
        });
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    })();

    const statuses: number[] = [];
    const correlationIds: string[] = [];
    let next = 0;
    const started = process.hrtime.bigint();
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < REQUESTS) {
          next += 1;
          const res = await request(app.url)
            .post('/v1/operator/deposits')
            .auth(auditor, { type: 'bearer' })
            .send({});
          statuses.push(res.status);
          correlationIds.push(String(res.headers['x-correlation-id']));
        }
      }),
    );
    const elapsedMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    sampling = false;
    await sampler;

    const max = (pick: (s: Sample) => number): number => Math.max(...samples.map(pick));
    const report = {
      requests: REQUESTS,
      concurrency: CONCURRENCY,
      poolMax: POOL_MAX,
      elapsedMs,
      requestsPerSecond: Math.round((REQUESTS * 1000) / elapsedMs),
      samples: samples.length,
      maxServerConnections: max(s => s.server),
      maxActive: max(s => s.active),
      maxIdleInTransaction: max(s => s.idleInTx),
      maxPoolTotal: max(s => s.poolTotal),
      maxPoolWaiting: max(s => s.poolWaiting),
    };
    process.stdout.write(`BL-019 recordDenied load: ${JSON.stringify(report)}\n`);

    expect(statuses).toHaveLength(REQUESTS);
    expect(statuses.filter(status => status !== 403)).toEqual([]);
    const [{ n: after }] = await q(`SELECT count(*)::int AS n FROM audit_log`);
    expect(Number(after) - Number(before)).toBe(REQUESTS);
    const [{ n: distinct }] = await q(
      `SELECT count(DISTINCT correlation_id)::int AS n FROM audit_log
        WHERE correlation_id = ANY($1::uuid[]) AND action = 'access.denied' AND outcome = 'DENIED'`,
      [correlationIds],
    );
    expect(Number(distinct)).toBe(REQUESTS);
    expect(report.maxServerConnections).toBeLessThanOrEqual(POOL_MAX);
    expect(report.maxPoolTotal).toBeLessThanOrEqual(POOL_MAX);
    // A refusal's transaction is short: nothing may stay open or idle in a transaction afterwards.
    const settled = await appConnections();
    expect(settled.active).toBe(0);
    expect(settled.idleInTx).toBe(0);
  }, 120_000);
});
