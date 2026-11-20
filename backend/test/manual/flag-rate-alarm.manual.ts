import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { MetricsService } from '@common/metrics';
import type { EmfDocument } from '@common/metrics/emf';
import { countDecision } from '@modules/risk/risk-scoring.metrics';
import { startDepositApp } from '../support/deposit-app';
import { buildRiskConsumer, eventFor, riskFixtures } from '../support/risk-consumer';
import { createTempDatabase, migrate } from '../support/temp-database';

/**
 * DBS-188 M-188-02, M-188-04..08: the traffic behind the alarm `dbs-dev-risk-flag-rate`.
 *
 * `generate <outDir>`: real API (customers, deposits, transfers), real consumer, real `MetricsService`
 * with `Role=worker`, a temporary PostgreSQL database (DATABASE_URL, as the db-specs). Writes one file
 * of EMF lines per stage (`stage-A.jsonl` ... `stage-E.jsonl`) and prints the running totals:
 *
 *   A  600 ordinary transfers (LOW, no flag)                          600 decisions,  0 flags
 *   B  255 ordinary + 45 account-takeover drains (R3 + R6, MEDIUM)    900 decisions, 45 flags  (50 per 1,000, under 1,000 transfers)
 *   C  150 ordinary                                                  1,050 decisions, 45 flags  (42.86 per 1,000)
 *   D  1,200 decisions counted through `countDecision` with no transfer behind them (the one synthetic step)
 *                                                                    2,250 decisions, 45 flags  (exactly 20.00 per 1,000)
 *   E  one more drain                                                2,251 decisions, 46 flags  (20.44 per 1,000)
 *
 * `ship <file> <logGroup> <logStream> <namespace>`: puts the lines of a stage file into a CloudWatch
 * Logs group with `aws logs put-log-events` (timestamp = now, namespace replaced) so CloudWatch
 * extracts the metrics. Needs AWS_PROFILE and the group and stream to exist.
 *
 *   npx ts-node -r tsconfig-paths/register test/manual/flag-rate-alarm.manual.ts generate ../out
 *   npx ts-node -r tsconfig-paths/register test/manual/flag-rate-alarm.manual.ts ship ../out/stage-A.jsonl <group> <stream> DBS/Check-dbs188
 */
const SURNAMES = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Vũ', 'Đặng', 'Bùi', 'Đỗ', 'Ngô'];
const GIVEN = [
  'Văn An',
  'Thị Bình',
  'Minh Châu',
  'Quốc Dũng',
  'Thu Hà',
  'Gia Huy',
  'Ngọc Lan',
  'Đức Mạnh',
  'Hải Nam',
  'Thanh Phương',
];
const name = (n: number) =>
  `${SURNAMES[n % SURNAMES.length]} ${GIVEN[Math.floor(n / SURNAMES.length) % GIVEN.length]}`;

const ORDINARY = { balance: '5000000', amount: '100000', perSender: 5 };
const DRAIN = { balance: '21000000', amount: '20000000' };

async function generate(outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const db = await createTempDatabase();
  let source: DataSource | undefined;
  let app: Awaited<ReturnType<typeof startDepositApp>> | undefined;
  try {
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    app = await startDepositApp(db.url);
    const fx = riskFixtures(app, await app.issuer.token('operator', { sub: randomUUID() }));
    const docs: EmfDocument[] = [];
    const metrics = new MetricsService(
      { enabled: true, flushMs: 600_000 },
      { role: 'worker' } as never,
      d => docs.push(d),
    );
    await metrics.start();
    const { consumer } = buildRiskConsumer(source, { metrics });

    let person = 0;
    const recipients: string[] = [];
    for (let i = 0; i < 10; i++) recipients.push((await fx.customer(name(person++))).accounts[0]);

    const score = async (token: string, from: string, to: string, amount: string) => {
      const id = await fx.transfer(token, from, to, amount);
      await consumer.handle(await eventFor(db.runner, id));
    };
    const ordinary = async (transfers: number) => {
      for (let done = 0; done < transfers; done += ORDINARY.perSender) {
        const sender = await fx.customer(name(person++));
        // One payee per sender: five new payees within an hour is rule R5 and would flag ordinary traffic.
        const recipient = recipients[person % recipients.length];
        await fx.deposit(sender.accounts[0], ORDINARY.balance);
        for (let k = 0; k < ORDINARY.perSender; k++) {
          await score(sender.token, sender.accounts[0], recipient, ORDINARY.amount);
        }
      }
    };
    const drains = async (count: number) => {
      for (let i = 0; i < count; i++) {
        const victim = await fx.customer(name(person++));
        await fx.deposit(victim.accounts[0], DRAIN.balance);
        await score(
          victim.token,
          victim.accounts[0],
          recipients[i % recipients.length],
          DRAIN.amount,
        );
      }
    };
    // Totals seen in the EMF lines themselves (what CloudWatch will sum), per metric, over all stages so far.
    const emfTotal = { risk_decision_total: 0, risk_flag_total: 0 };
    const count = async (sql: string) =>
      Number(((await db.runner.query(sql)) as { n: string }[])[0].n);
    const stage = async (
      label: string,
      run: () => Promise<void>,
      want: { decisions: number; flags: number },
    ) => {
      docs.length = 0;
      await run();
      await metrics.flush();
      // Only the two counters the alarm reads are shipped (the harness also writes a Redis fallback counter: Redis is down here).
      const lines = docs.filter(d =>
        d._aws.CloudWatchMetrics[0].Metrics.some(m => m.Name in emfTotal),
      );
      for (const d of lines) {
        const metric = d._aws.CloudWatchMetrics[0].Metrics[0].Name as keyof typeof emfTotal;
        emfTotal[metric] += Number(d[metric]);
      }
      writeFileSync(
        join(outDir, `stage-${label}.jsonl`),
        lines.map(d => JSON.stringify(d)).join('\n') + '\n',
      );
      const sqlDecisions = await count(`SELECT count(*) AS n FROM risk_decisions`);
      const sqlFlags = await count(`SELECT count(*) AS n FROM fraud_flags`);
      const ratio = emfTotal.risk_decision_total
        ? (1000 * emfTotal.risk_flag_total) / emfTotal.risk_decision_total
        : 0;
      console.log(
        `stage ${label}: EMF decisions=${emfTotal.risk_decision_total} flags=${emfTotal.risk_flag_total} ` +
          `(SQL risk_decisions=${sqlDecisions}, fraud_flags=${sqlFlags}); ${ratio.toFixed(2)} per 1,000; ${lines.length} line(s)`,
      );
      assert.equal(emfTotal.risk_decision_total, want.decisions, `${label}: decisions in EMF`);
      assert.equal(emfTotal.risk_flag_total, want.flags, `${label}: flags in EMF`);
      assert.equal(sqlFlags, want.flags, `${label}: fraud_flags rows`);
      return { sqlDecisions, sqlFlags };
    };

    await stage('A', () => ordinary(600), { decisions: 600, flags: 0 });
    await stage(
      'B',
      async () => {
        await ordinary(255);
        await drains(45);
      },
      { decisions: 900, flags: 45 },
    );
    await stage('C', () => ordinary(150), { decisions: 1050, flags: 45 });
    // The one synthetic step: 1,200 decisions counted through the real counter with no transfer behind them.
    const d = await stage(
      'D',
      () => {
        for (let i = 0; i < 1200; i++) countDecision('DISABLED');
        return Promise.resolve();
      },
      { decisions: 2250, flags: 45 },
    );
    assert.equal(d.sqlDecisions, 1050, 'D adds no row to risk_decisions');
    const last = await stage('E', () => drains(1), { decisions: 2251, flags: 46 });
    assert.equal(last.sqlDecisions, 1051);
    console.log('generate OK');
  } finally {
    await app?.close();
    await source?.destroy();
    await db.drop();
  }
}

function ship(file: string, group: string, stream: string, namespace: string): void {
  const now = Date.now();
  const events = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      const doc = JSON.parse(line) as EmfDocument;
      doc._aws.Timestamp = now;
      doc._aws.CloudWatchMetrics[0].Namespace = namespace;
      return { timestamp: now + i, message: JSON.stringify(doc) };
    });
  const batch = join(process.env.TEMP ?? '.', `flag-rate-alarm-${now}.json`);
  writeFileSync(batch, JSON.stringify(events));
  const res = spawnSync(
    'aws',
    [
      'logs',
      'put-log-events',
      '--log-group-name',
      group,
      '--log-stream-name',
      stream,
      '--log-events',
      `file://${batch}`,
    ],
    { encoding: 'utf8', shell: true },
  );
  console.log(res.stdout, res.stderr);
  if (res.status !== 0) process.exit(res.status ?? 1);
  console.log(`shipped ${events.length} line(s) of ${file} at ${new Date(now).toISOString()}`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'generate' && rest.length === 1) {
  generate(rest[0]).catch(err => {
    console.error(err);
    process.exit(1);
  });
} else if (mode === 'ship' && rest.length === 4) {
  ship(rest[0], rest[1], rest[2], rest[3]);
} else {
  console.error('usage: generate <outDir> | ship <file> <logGroup> <logStream> <namespace>');
  process.exit(2);
}
