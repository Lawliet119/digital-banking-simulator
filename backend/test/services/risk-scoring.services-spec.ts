import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { RedisClient, RedisMetrics } from '@libs/redis';
import { SqsClient, type BatchResult } from '@libs/sqs';
import { OutboxRelayService } from '@modules/outbox';
import { RiskScoringConsumer } from '@modules/risk/risk-scoring.consumer';
import { startDepositApp } from '../support/deposit-app';
import { startElasticMqContainer, type StartedElasticMq } from '../support/elasticmq.container';
import {
  buildRiskConsumer,
  eventFor,
  riskFixtures,
  type RiskConsumerParts,
} from '../support/risk-consumer';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';

/** The production consumer with a 1-second long poll, so stopping the loop in teardown is quick. */
class FastPollConsumer extends RiskScoringConsumer {
  override consumeOnce(waitTimeSeconds = 1, visibilityTimeout?: number): Promise<BatchResult[]> {
    return super.consumeOnce(waitTimeSeconds, visibilityTimeout);
  }
}

const SOURCES = 10;
const SPACING_MS = 300;

/**
 * DBS-111 end to end with the real loops: HTTP transfers → outbox → relay loop → ElasticMQ →
 * risk consumer loop → flag, on PostgreSQL, Valkey and ElasticMQ containers. Nothing is pumped by
 * hand: the relay and the consumer poll on their own while transfers arrive spaced out, so the
 * measured time from transfer to flag includes the real polling (DoD #3; SLO p95 < 5 s).
 */
describe('DBS-111 transfer → flag through the real relay and consumer loops', () => {
  let mq: StartedElasticMq;
  let valkey: StartedValkey;
  let db: TempDatabase;
  let source: DataSource;
  let sqs: SqsClient;
  let redis: RedisClient;
  let relay: OutboxRelayService;
  let parts: RiskConsumerParts;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  let fx: ReturnType<typeof riskFixtures>;
  let riskUrl: string;
  const saved = {
    role: process.env.APP_ROLE,
    key: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
  };
  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []) =>
    db.runner.query(sql, args) as Promise<T[]>;
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  async function until(check: () => Promise<boolean>, what: string, ms = 60_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return;
      await wait(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    process.env.APP_ROLE = 'both';
    mq = await startElasticMqContainer();
    valkey = await startValkeyContainer();
    riskUrl = new URL('/000000000000/risk-events', mq.endpoint).toString();
    const notificationUrl = new URL('/000000000000/notification-events', mq.endpoint).toString();
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({
      type: 'postgres',
      url: db.url,
      extra: { max: 10 },
    }).initialize();
    sqs = new SqsClient({ region: 'us-east-1', endpoint: mq.endpoint });
    redis = new RedisClient({ url: valkey.url, commandTimeoutMs: 50 }, new RedisMetrics());
    await until(() => Promise.resolve(redis.isReady), 'Valkey', 10_000);
    const tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    relay = new OutboxRelayService(tx, sqs, {
      region: 'us-east-1',
      endpoint: mq.endpoint,
      riskQueueUrl: riskUrl,
      notificationQueueUrl: notificationUrl,
    });
    parts = buildRiskConsumer(source, {
      redis,
      sqs,
      queueUrl: riskUrl,
      make: (...args) => new FastPollConsumer(...args),
    });
    app = await startDepositApp(db.url);
    fx = riskFixtures(app, await app.issuer.token('operator', { sub: randomUUID() }));
    relay.onApplicationBootstrap();
    parts.consumer.onApplicationBootstrap();
  });
  afterAll(async () => {
    try {
      await parts?.consumer.onApplicationShutdown();
      await relay?.onApplicationShutdown();
      await app?.close();
      redis?.onModuleDestroy();
      sqs?.onModuleDestroy();
      await source?.destroy();
      await db?.drop();
      await valkey?.stop();
      await mq?.stop();
    } finally {
      restore('APP_ROLE', saved.role);
      restore('AWS_ACCESS_KEY_ID', saved.key);
      restore('AWS_SECRET_ACCESS_KEY', saved.secret);
    }
  });

  it('TC-111-13 AC-9.1 transfers arriving every 300 ms are flagged by the running loops; p95 transfer → flag < 5 s; audit carries the transfer correlationId; a redelivery adds nothing', async () => {
    const sources: { token: string; from: string; to: string }[] = [];
    for (let i = 0; i < SOURCES; i++) {
      const an = await fx.customer(`Trần Văn An ${i + 1}`);
      const binh = await fx.customer(`Nguyễn Thị Bình ${i + 1}`);
      await fx.deposit(an.accounts[0], '21000000');
      sources.push({ token: an.token, from: an.accounts[0], to: binh.accounts[0] });
    }
    const ids: string[] = [];
    for (const s of sources) {
      ids.push(await fx.transfer(s.token, s.from, s.to, '20000000'));
      await wait(SPACING_MS);
    }
    const flagged = async () =>
      (
        await q<{ n: number }>(
          'SELECT count(*)::int AS n FROM fraud_flags WHERE transfer_id = ANY($1::uuid[])',
          [ids],
        )
      )[0].n;
    await until(async () => (await flagged()) === SOURCES, 'all flags');

    const latencies = (
      await q<{ ms: string }>(
        `SELECT (extract(epoch FROM f.created_at - t.created_at) * 1000)::numeric(10,1)::text AS ms
           FROM fraud_flags f JOIN transfers t ON t.id = f.transfer_id
          WHERE f.transfer_id = ANY($1::uuid[])`,
        [ids],
      )
    )
      .map(row => Number(row.ms))
      .sort((a, b) => a - b);
    const pick = (p: number) =>
      latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)];
    const summary = {
      n: latencies.length,
      p50: pick(0.5),
      p95: pick(0.95),
      max: latencies[latencies.length - 1],
    };
    console.log(`DBS-111 transfer → flag ms: ${JSON.stringify(summary)}`);
    expect(summary.p95).toBeLessThan(5000);

    const rows = await q<{ score: number; risk_level: string; rules: string }>(
      `SELECT f.score, f.risk_level, string_agg(h.rule_id, ',' ORDER BY h.rule_id) AS rules
         FROM fraud_flags f JOIN fraud_rule_hits h ON h.transfer_id = f.transfer_id
        WHERE f.transfer_id = ANY($1::uuid[]) GROUP BY f.transfer_id, f.score, f.risk_level`,
      [ids],
    );
    expect(rows).toHaveLength(SOURCES);
    for (const row of rows)
      expect(row).toEqual({ score: 65, risk_level: 'MEDIUM', rules: 'R3,R6' });
    const mismatched = await q(
      `SELECT t.id FROM transfers t
         LEFT JOIN audit_log a ON a.action = 'fraud.flagged' AND a.target_id = t.id::text
        WHERE t.id = ANY($1::uuid[]) AND (a.correlation_id IS DISTINCT FROM t.correlation_id)`,
      [ids],
    );
    expect(mismatched).toEqual([]);

    // Redelivery: the same message again, and a copy under a new eventId. Wait for the copy's claim
    // (proof the consumer got past both), then check nothing else was written.
    const event = await eventFor(db.runner, ids[0]);
    const copy = { ...event, eventId: randomUUID() };
    await sqs.send(riskUrl, JSON.stringify(event));
    await sqs.send(riskUrl, JSON.stringify(copy));
    await until(
      async () =>
        (
          await q<{ n: number }>(
            "SELECT count(*)::int AS n FROM processed_events WHERE consumer = 'risk' AND event_id = $1",
            [copy.eventId],
          )
        )[0].n === 1,
      'the redelivered copy',
    );
    expect(await flagged()).toBe(SOURCES);
    expect(
      (
        await q<{ n: number }>(
          'SELECT count(*)::int AS n FROM risk_decisions WHERE transfer_id = $1',
          [ids[0]],
        )
      )[0].n,
    ).toBe(1);
  });
});
