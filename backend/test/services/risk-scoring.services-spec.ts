import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';
import { PinoLogger } from 'nestjs-pino';
import { DataSource } from 'typeorm';
import { MetricsService } from '@common/metrics';
import type { EmfDocument } from '@common/metrics/emf';
import request from 'supertest';
import { TransactionService } from '@database/transaction.service';
import { RedisClient, RedisMetrics } from '@libs/redis';
import { SqsClient, type BatchResult } from '@libs/sqs';
import { OutboxRelayService } from '@modules/outbox';
import { RiskScoringConsumer } from '@modules/risk/risk-scoring.consumer';
import { createLoopbackAdapter } from '@modules/risk/ai/openai-decisions';
import { RiskAiService } from '@modules/risk/ai/risk-ai.service';
import { checkLedgerInvariants } from '../support/invariants';
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
  let metrics: MetricsService;
  const emf: EmfDocument[] = [];
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
    metrics = new MetricsService(
      { enabled: true, flushMs: 600_000 },
      { role: 'worker' } as never,
      new PinoLogger({ pinoHttp: { level: 'silent' } } as never),
      doc => emf.push(doc),
    );
    await metrics.start();
    parts = buildRiskConsumer(source, {
      metrics,
      redis,
      sqs,
      queueUrl: riskUrl,
      make: (...args) => new FastPollConsumer(...args),
    });
    app = await startDepositApp(db.url, { fraud: true });
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

    // BL-204: the same measure as the metric the consumer wrote while the loops ran.
    const names = (d: EmfDocument) => d._aws.CloudWatchMetrics[0].Metrics.map(m => m.Name);
    const flagSamples = () =>
      emf
        .filter(d => names(d).includes('risk_transfer_to_flag_ms'))
        .flatMap(d => d.risk_transfer_to_flag_ms as number[]);
    // The metric is recorded right after the commit that made the flag visible: poll until it is in.
    await until(async () => {
      await metrics.flush();
      return flagSamples().length >= SOURCES;
    }, 'the flag latency samples');
    const samples = flagSamples().sort((a, b) => a - b);
    expect(samples).toHaveLength(SOURCES);
    // A bucket bound is never lower than the real latency, and p95 stays under the 5 s SLO.
    expect(samples[samples.length - 1]).toBeGreaterThanOrEqual(summary.max);
    expect(samples[Math.ceil(0.95 * SOURCES) - 1]).toBeLessThanOrEqual(5000);
    const decisions = emf.filter(d => names(d).includes('risk_decision_total'));
    expect(new Set(decisions.map(d => d.AiStatus))).toEqual(new Set(['DISABLED']));
    expect(decisions.reduce((sum, d) => sum + Number(d.risk_decision_total), 0)).toBe(SOURCES);

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

  it('transfer → real queue → gated synthetic AI → operator review, without a duplicate decision', async () => {
    await parts.consumer.onApplicationShutdown();
    const calls: unknown[] = [];
    const provider = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => {
        body += String(chunk);
      });
      req.on('end', () => {
        calls.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'synthetic-e2e' });
        res.end(
          JSON.stringify({
            model: 'synthetic-response',
            answers: [{ name: 'needs_operator_review', type: 'predicate', probability: 0.95 }],
          }),
        );
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    try {
      const aiConfig = {
        provider: 'openai',
        model: 'synthetic-model',
        rubric: 'needs_operator_review: evaluate synthetic transfer',
        threshold: 0.8,
        weight: 45,
        maxAdmissionDelayMs: 5000,
        requestTimeoutMs: 3000,
      };
      await q(
        `INSERT INTO risk_rule_sets(version,config)
         SELECT 2,config || jsonb_build_object('mode','rules_with_external_ai','ai',$1::jsonb)
         FROM risk_rule_sets WHERE version=1`,
        [JSON.stringify(aiConfig)],
      );
      await q(
        `INSERT INTO ai_gate_policy(singleton,revision,daily_limit,concurrent_limit)
         VALUES(true,'synthetic-e2e',10,2)`,
      );
      const ai = new RiskAiService(
        {
          approved: true,
          policyRevision: 'synthetic-e2e',
          dailyRequestLimit: 10,
          concurrentLimit: 2,
          gateTimeoutMs: 1000,
          apiKey: 'synthetic-test-only',
        },
        {
          url: db.url,
          ssl: false,
          sslCaPath: undefined,
          poolMax: 5,
          lockTimeoutMs: 2000,
          statementTimeoutMs: 5000,
          idleInTransactionTimeoutMs: 10000,
        },
        createLoopbackAdapter(
          `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1/decisions`,
        ),
      );
      parts = buildRiskConsumer(source, {
        ai,
        sqs,
        queueUrl: riskUrl,
        make: (...args) => new FastPollConsumer(...args),
      });
      parts.consumer.onApplicationBootstrap();

      const sender = await fx.customer('Khách tổng hợp A');
      const recipient = await fx.customer('Khách tổng hợp B');
      await fx.deposit(sender.accounts[0], '1000000');
      const id = await fx.transfer(sender.token, sender.accounts[0], recipient.accounts[0], '1000');
      await until(
        async () => (await q('SELECT 1 FROM fraud_flags WHERE transfer_id=$1', [id])).length === 1,
        'AI-only flag',
      );
      expect(
        await q(
          'SELECT rule_score,ai_applied_weight,ai_status FROM risk_decisions WHERE transfer_id=$1',
          [id],
        ),
      ).toEqual([{ rule_score: 0, ai_applied_weight: 45, ai_status: 'SUCCEEDED' }]);
      expect(calls).toHaveLength(1);
      const body = calls[0] as { input: { content: { data: Record<string, unknown> }[] }[] };
      expect(Object.keys(body.input[0].content[0].data)).toHaveLength(11);
      expect(JSON.stringify(body)).not.toContain(id);
      expect(JSON.stringify(body)).not.toContain(sender.accounts[0]);

      const operator = await app.issuer.token('operator', { sub: randomUUID() });
      const detail = await request(app.url)
        .get(`/v1/operator/fraud-flags/${id}`)
        .auth(operator, { type: 'bearer' })
        .expect(200);
      expect(detail.body).toMatchObject({
        score: 45,
        hits: [],
        aiAssessment: { status: 'SUCCEEDED', probability: 0.95, model: 'synthetic-response' },
      });
      await request(app.url)
        .get(`/v1/operator/fraud-flags/${id}`)
        .auth(sender.token, { type: 'bearer' })
        .expect(403);
      await request(app.url)
        .post(`/v1/operator/fraud-flags/${id}/review`)
        .auth(operator, { type: 'bearer' })
        .send({ decision: 'FALSE_POSITIVE' })
        .expect(200);
      await request(app.url)
        .post(`/v1/operator/fraud-flags/${id}/review`)
        .auth(operator, { type: 'bearer' })
        .send({ decision: 'CONFIRMED_FRAUD' })
        .expect(409);

      const event = await eventFor(db.runner, id);
      const copy = { ...event, eventId: randomUUID() };
      await sqs.send(riskUrl, JSON.stringify(copy));
      await until(
        async () =>
          (
            await q("SELECT 1 FROM processed_events WHERE consumer='risk' AND event_id=$1", [
              copy.eventId,
            ])
          ).length === 1,
        'AI redelivery',
      );
      expect(calls).toHaveLength(1);
      expect(
        await q('SELECT count(*)::int AS n FROM risk_decisions WHERE transfer_id=$1', [id]),
      ).toEqual([{ n: 1 }]);
      expect(
        await q(
          "SELECT count(*)::int AS n FROM audit_log WHERE action='fraud_flag.review' AND target_id=$1",
          [id],
        ),
      ).toEqual([{ n: 1 }]);
      expect((await checkLedgerInvariants(db.runner)).violations).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        provider.close(error => (error ? reject(error) : resolve())),
      );
    }
  });
});
