import { randomUUID } from 'node:crypto';
import { installSilentRootLogger } from '../support/silent-root-logger';
import { DataSource } from 'typeorm';
import { startDepositApp } from '../support/deposit-app';
import {
  buildRiskConsumer,
  eventFor,
  riskFixtures,
  type RiskConsumerParts,
} from '../support/risk-consumer';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

installSilentRootLogger();

/* eslint-disable @typescript-eslint/no-require-imports -- the tool is a CommonJS file shared with the k6 runner */
interface Lag {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}
interface Win {
  transfers: number;
  decided: number;
  undecided: number;
  flagged: number;
  flagP95UnderSlo: boolean | null;
  decisionLagMs: Lag;
  flagLagMs: Lag;
  modes: unknown[];
  perMinute: { transfers: number; flagged: number }[];
  sourceAccountRows30d: { source: string; rows30d: number }[];
}
type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
const lib = require('../../../load-tests/lib/flag-latency.cjs') as {
  measure: (
    c: Db,
    w: unknown[],
    o: { settleSeconds: number },
  ) => Promise<{ backlog: boolean; undecidedAfterSettle: number; windows: Win[] }>;
  measureWindow: (c: Db, w: unknown) => Promise<Win>;
};
const { measure, measureWindow } = lib;

/**
 * DBS-174: the SQL of `load-tests/lib/flag-latency.cjs` on real PostgreSQL, fed by the real risk consumer, so the
 * measured lag is the one the worker produces: `risk_decisions.decided_at` and `fraud_flags.created_at` minus
 * `transfers.created_at`. Design: docs/features/DBS-174-time-to-flag.md.
 */
describe('DBS-174 flag latency tool on PostgreSQL', () => {
  let db: TempDatabase;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  let source: DataSource;
  let parts: RiskConsumerParts;
  let fx: ReturnType<typeof riskFixtures>;
  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []) =>
    db.runner.query(sql, args) as Promise<T[]>;
  // pg.Client shape: `{ rows }`.
  const client = () => ({
    query: async (sql: string, params?: unknown[]) => ({ rows: await q(sql, params) }),
  });
  const wide = () => ({
    label: 'all',
    from: new Date(Date.now() - 3600_000).toISOString(),
    to: new Date(Date.now() + 3600_000).toISOString(),
  });
  const message = { MessageId: randomUUID(), Attributes: { ApproximateReceiveCount: '1' } };

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    fx = riskFixtures(app, await app.issuer.token('operator', { sub: randomUUID() }));
    source = await new DataSource({
      type: 'postgres',
      url: db.url,
      extra: { max: 10 },
    }).initialize();
    parts = buildRiskConsumer(source);
  });
  afterAll(async () => {
    try {
      await app?.close();
      await source?.destroy();
    } finally {
      await db?.drop();
    }
  });

  it('TC-174-11 one flagged and one clean transfer: counts, lag equal to the stored timestamps, decision lag <= flag lag', async () => {
    const an = await fx.customer('Trần Văn An');
    const binh = await fx.customer('Nguyễn Thị Bình');
    await fx.deposit(an.accounts[0], '21000000');
    // BRD AC-9.1: a new account sending 20M out of 21M is R3 + R6 = 65, MEDIUM -> flag.
    const flaggedId = await fx.transfer(an.token, an.accounts[0], binh.accounts[0], '20000000');
    const cleanId = await fx.transfer(an.token, an.accounts[0], binh.accounts[0], '1000');
    for (const id of [flaggedId, cleanId])
      await parts.consumer.handle(await eventFor(db.runner, id), message);

    const report = await measure(client(), [wide()], { settleSeconds: 0 });
    const [w] = report.windows;
    expect(report.backlog).toBe(false);
    expect(w.transfers).toBe(2); // the deposit is a DEPOSIT, never counted
    expect(w.decided).toBe(2);
    expect(w.undecided).toBe(0);
    expect(w.flagged).toBe(1);
    expect(w.modes).toEqual([{ mode: 'rule_only', aiStatus: 'DISABLED', decisions: 2 }]);

    const [{ decision_ms, flag_ms }] = await q<{ decision_ms: number; flag_ms: number }>(
      `SELECT EXTRACT(EPOCH FROM d.decided_at - t.created_at) * 1000 AS decision_ms,
              EXTRACT(EPOCH FROM f.created_at - t.created_at) * 1000 AS flag_ms
         FROM transfers t JOIN risk_decisions d ON d.transfer_id = t.id JOIN fraud_flags f ON f.transfer_id = t.id
        WHERE t.id = $1`,
      [flaggedId],
    );
    expect(w.flagLagMs.p50).toBeCloseTo(Number(flag_ms), 1); // one flag: every percentile is that value
    expect(w.flagLagMs.p99).toBeCloseTo(Number(flag_ms), 1);
    expect(w.flagLagMs.max).toBeCloseTo(Number(flag_ms), 1);
    expect(Number(decision_ms)).toBeLessThanOrEqual(Number(flag_ms));
    expect(w.decisionLagMs.max).toBeGreaterThanOrEqual(Number(decision_ms) - 0.01);
    expect(w.flagLagMs.p95).toBeLessThan(5000);
    expect(w.flagP95UnderSlo).toBe(true);
    expect(w.perMinute.reduce((n, m) => n + m.transfers, 0)).toBe(2);
    expect(w.perMinute.reduce((n, m) => n + m.flagged, 0)).toBe(1);
  });

  it('TC-174-12 a completed transfer the worker has not scored is undecided: backlog true after the settle time, windows outside it are empty', async () => {
    const cuong = await fx.customer('Lê Văn Cường');
    const dung = await fx.customer('Phạm Thị Dung');
    await fx.deposit(cuong.accounts[0], '5000000');
    await fx.transfer(cuong.token, cuong.accounts[0], dung.accounts[0], '1000'); // never given to the consumer
    const report = await measure(client(), [wide()], { settleSeconds: 0 });
    expect(report.backlog).toBe(true);
    expect(report.undecidedAfterSettle).toBe(1);
    expect(report.windows[0].undecided).toBe(1);

    const past = await measureWindow(client(), {
      label: 'past',
      from: '2020-01-01T00:00:00.000Z',
      to: '2020-01-01T00:15:00.000Z',
    });
    expect(past).toMatchObject({ transfers: 0, decided: 0, flagged: 0, undecided: 0 });
    expect(past.decisionLagMs.p95).toBeNull();
    expect(past.flagLagMs.p95).toBeNull();
    expect(past.sourceAccountRows30d).toEqual([]);
  });

  it('TC-174-13 source account rows are the 30-day TRANSFER history up to the window end, per source, with no account id in the report', async () => {
    const [{ n, account }] = await q<{ n: number; account: string }>(
      `SELECT count(*)::int AS n, from_account_id AS account FROM transfers
        WHERE type = 'TRANSFER' AND status = 'COMPLETED' GROUP BY 2 ORDER BY 1 DESC LIMIT 1`,
    );
    const w = await measureWindow(client(), wide());
    expect(w.sourceAccountRows30d[0]).toEqual({ source: 'nguon-1', rows30d: n });
    expect(JSON.stringify(w)).not.toContain(account);
    // The window end is a cut: rows created after it are not in the 30-day count.
    const [{ first }] = await q<{ first: Date }>(
      `SELECT min(created_at) AS first FROM transfers WHERE type = 'TRANSFER'`,
    );
    const early = await measureWindow(client(), {
      label: 'early',
      from: new Date(first.getTime() - 1000).toISOString(),
      to: new Date(first.getTime() + 1).toISOString(),
    });
    expect(early.transfers).toBe(1);
    expect(early.sourceAccountRows30d.reduce((s, r) => s + r.rows30d, 0)).toBe(1);
  });
});
