import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { MetricsService } from '@common/metrics';
import type { EmfDocument } from '@common/metrics/emf';
import { createLoopbackAdapter } from '@modules/risk/ai/openai-decisions';
import { RiskAiService } from '@modules/risk/ai/risk-ai.service';
import { startDepositApp, type DepositApp } from '../support/deposit-app';
import { buildRiskConsumer, eventFor, riskFixtures } from '../support/risk-consumer';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/**
 * DBS-187 M-187-06: how the AI shows up in `risk_flag_total`. The real consumer, a temporary
 * PostgreSQL database and a synthetic AI on loopback (no provider, no key). The app has no setting
 * that points the AI at loopback, so this step cannot run on the app of M-187-01. Needs DATABASE_URL
 * (a PostgreSQL server) as the db-specs do. Prints each EMF line with `risk_flag_total`.
 *
 *   npx ts-node -r tsconfig-paths/register test/manual/flag-rate-ai.manual.ts
 */
const AI = {
  provider: 'openai',
  model: 'synthetic-model',
  rubric: 'needs_operator_review: synthetic review',
  threshold: 0.8,
  weight: 20,
  maxAdmissionDelayMs: 2000,
  requestTimeoutMs: 3000,
};

async function main(): Promise<void> {
  let db: TempDatabase | undefined;
  let source: DataSource | undefined;
  let app: DepositApp | undefined;
  let server: Server | undefined;
  try {
    db = await createTempDatabase();
    await migrate(db.url);
    const runner = db.runner;
    const q = (sql: string, args: unknown[] = []) => runner.query(sql, args) as Promise<unknown[]>;
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    app = await startDepositApp(db.url);
    const fx = riskFixtures(app, await app.issuer.token('operator', { sub: randomUUID() }));

    let outage = false;
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (outage) {
          res.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'synthetic' });
        res.end(
          JSON.stringify({
            model: 'synthetic-response',
            answers: [{ name: 'needs_operator_review', type: 'predicate', probability: 0.95 }],
          }),
        );
      });
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/decisions`;
    const runtime = () =>
      new RiskAiService(
        {
          approved: true,
          policyRevision: 'synthetic-manual',
          dailyRequestLimit: 100,
          concurrentLimit: 5,
          gateTimeoutMs: 1000,
          apiKey: 'synthetic-test-only',
        },
        {
          url: db!.url,
          ssl: false,
          sslCaPath: undefined,
          poolMax: 5,
          lockTimeoutMs: 2000,
          statementTimeoutMs: 5000,
          idleInTransactionTimeoutMs: 10000,
        },
        createLoopbackAdapter(endpoint),
      );
    await q(
      `INSERT INTO risk_rule_sets(version, config)
      SELECT 2, config || jsonb_build_object('mode', 'rules_with_external_ai', 'ai', $1::jsonb)
        FROM risk_rule_sets WHERE version = 1`,
      [JSON.stringify(AI)],
    );
    await q(`INSERT INTO ai_gate_policy(singleton, revision, daily_limit, concurrent_limit)
      VALUES (true, 'synthetic-manual', 100, 5)`);

    const sender = async (balance: string, amount: string, n: string) => {
      const from = await fx.customer(`Khách gửi ${n}`);
      const to = await fx.customer(`Khách nhận ${n}`);
      await fx.deposit(from.accounts[0], balance);
      const id = await fx.transfer(from.token, from.accounts[0], to.accounts[0], amount);
      return eventFor(runner, id);
    };
    const cases: Array<{
      name: string;
      outage: boolean;
      amount: string;
      balance: string;
      want: string;
    }> = [
      {
        name: 'raised',
        outage: false,
        balance: '21000000',
        amount: '20000000',
        want: 'HIGH/rules_with_external_ai/raised',
      },
      {
        name: 'created',
        outage: false,
        balance: '5000000',
        amount: '4700000',
        want: 'MEDIUM/rules_with_external_ai/created',
      },
      {
        name: 'none (AI fails)',
        outage: true,
        balance: '21000000',
        amount: '20000000',
        want: 'MEDIUM/rules_with_external_ai/none',
      },
    ];
    let n = 0;
    for (const c of cases) {
      outage = c.outage;
      const docs: EmfDocument[] = [];
      const metrics = new MetricsService(
        { enabled: true, flushMs: 600_000 },
        { role: 'worker' } as never,
        d => docs.push(d),
      );
      await metrics.start();
      const event = await sender(c.balance, c.amount, String(++n));
      await buildRiskConsumer(source, { ai: runtime(), metrics }).consumer.handle(event);
      await metrics.flush();
      const line = docs.find(d =>
        d._aws.CloudWatchMetrics[0].Metrics.some(m => m.Name === 'risk_flag_total'),
      );
      assert.ok(line, `${c.name}: no risk_flag_total line`);
      const got = `${String(line.RiskLevel)}/${String(line.Mode)}/${String(line.AiAdded)}`;
      console.log(`${c.name}: ${JSON.stringify(line)}`);
      assert.equal(got, c.want, c.name);
      assert.equal(line.risk_flag_total, 1);
    }
    console.log('M-187-06 OK');
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await app?.close();
    await source?.destroy();
    await db?.drop();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
