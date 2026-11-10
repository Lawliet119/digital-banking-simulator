import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { SqsClient, type BatchResult } from '@libs/sqs';
import { OutboxRelayService } from '@modules/outbox';
import { assess, createLoopbackAdapter } from '@modules/risk/ai/openai-decisions';
import { REVIEW_RUBRIC } from '@modules/risk/ai/rubric';
import { RiskAiService } from '@modules/risk/ai/risk-ai.service';
import { RiskScoringConsumer } from '@modules/risk/risk-scoring.consumer';
import { startDepositApp, type DepositApp } from '../support/deposit-app';
import { startElasticMqContainer, type StartedElasticMq } from '../support/elasticmq.container';
import { checkLedgerInvariants } from '../support/invariants';
import {
  buildRiskConsumer,
  eventFor,
  riskFixtures,
  type RiskConsumerParts,
} from '../support/risk-consumer';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

class FastPollConsumer extends RiskScoringConsumer {
  override consumeOnce(waitTimeSeconds = 1, visibilityTimeout?: number): Promise<BatchResult[]> {
    return super.consumeOnce(waitTimeSeconds, visibilityTimeout);
  }
}

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(100);
  }
  throw new Error(`Timeout: ${label}`);
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live-openai');
  const apiKey = live ? process.env.OPENAI_API_KEY : 'synthetic-test-only';
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for the live synthetic test');
  const saved = {
    APP_ROLE: process.env.APP_ROLE,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  };
  process.env.APP_ROLE = 'both';
  process.env.AWS_ACCESS_KEY_ID = 'local';
  process.env.AWS_SECRET_ACCESS_KEY = 'local';
  let mq: StartedElasticMq | undefined;
  let db: TempDatabase | undefined;
  let source: DataSource | undefined;
  let sqs: SqsClient | undefined;
  let relay: OutboxRelayService | undefined;
  let parts: RiskConsumerParts | undefined;
  let app: DepositApp | undefined;
  let provider: Server | undefined;
  let calls = 0;
  try {
    mq = await startElasticMqContainer();
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    const runner = db.runner;
    const q = (sql: string, params: unknown[] = []) => runner.query(sql, params);
    const riskUrl = new URL('/000000000000/risk-events', mq.endpoint).toString();
    const notificationUrl = new URL('/000000000000/notification-events', mq.endpoint).toString();
    sqs = new SqsClient({ region: 'us-east-1', endpoint: mq.endpoint });
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
    app = await startDepositApp(db.url, { fraud: true });
    const fx = riskFixtures(app, await app.issuer.token('operator', { sub: randomUUID() }));
    let assessor = assess;
    if (!live) {
      provider = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          calls++;
          res.writeHead(200, {
            'content-type': 'application/json',
            'x-request-id': 'synthetic-manual',
          });
          res.end(
            JSON.stringify({
              model: 'synthetic-response',
              answers: [{ name: 'needs_operator_review', type: 'predicate', probability: 0.95 }],
            }),
          );
        });
      });
      await new Promise<void>(resolve => provider!.listen(0, '127.0.0.1', resolve));
      const port = (provider.address() as AddressInfo).port;
      assessor = createLoopbackAdapter(`http://127.0.0.1:${port}/v1/decisions`);
    }
    const aiConfig = {
      provider: 'openai',
      model: live ? 'gpt-6-luna' : 'synthetic-model',
      rubric: live ? REVIEW_RUBRIC : 'needs_operator_review: evaluate synthetic transfer',
      threshold: live ? 0.5 : 0.8,
      weight: 45,
      maxAdmissionDelayMs: 5000,
      requestTimeoutMs: live ? 30000 : 3000,
    };
    await q(
      `INSERT INTO risk_rule_sets(version,config)
      SELECT 2,config || jsonb_build_object('mode','rules_with_external_ai','ai',$1::jsonb)
      FROM risk_rule_sets WHERE version=1`,
      [JSON.stringify(aiConfig)],
    );
    await q(`INSERT INTO ai_gate_policy(singleton,revision,daily_limit,concurrent_limit)
      VALUES(true,'synthetic-manual',10,2)`);
    const ai = new RiskAiService(
      {
        approved: true,
        policyRevision: 'synthetic-manual',
        dailyRequestLimit: 10,
        concurrentLimit: 2,
        gateTimeoutMs: live ? 3000 : 1000,
        apiKey,
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
      assessor,
    );
    parts = buildRiskConsumer(source, {
      ai,
      sqs,
      queueUrl: riskUrl,
      make: (...args) => new FastPollConsumer(...args),
    });
    relay.onApplicationBootstrap();
    parts.consumer.onApplicationBootstrap();
    const sender = await fx.customer('Khách tổng hợp A');
    const recipient = await fx.customer('Khách tổng hợp B');
    await fx.deposit(sender.accounts[0], live ? '12000000' : '1000000');
    const id = await fx.transfer(
      sender.token,
      sender.accounts[0],
      recipient.accounts[0],
      live ? '11000000' : '1000',
    );
    await until(
      async () => (await q('SELECT 1 FROM fraud_flags WHERE transfer_id=$1', [id])).length === 1,
      'flag',
    );
    const [decision] = await q(
      `SELECT rule_score,ai_applied_weight,ai_status,probability,requested_model,response_model
       FROM risk_decisions WHERE transfer_id=$1`,
      [id],
    );
    assert.equal(decision.ai_status, 'SUCCEEDED');
    if (live) {
      assert.equal(decision.rule_score, 65);
      assert.equal(decision.requested_model, 'gpt-6-luna');
      assert.equal(decision.response_model, 'gpt-6-luna');
      assert.ok(Number.isFinite(decision.probability));
      assert.ok(decision.probability >= 0 && decision.probability <= 1);
      assert.equal(decision.ai_applied_weight, decision.probability >= aiConfig.threshold ? 45 : 0);
    } else {
      assert.equal(decision.rule_score, 0);
      assert.equal(decision.ai_applied_weight, 45);
      assert.equal(calls, 1);
    }
    const operator = await app.issuer.token('operator', { sub: randomUUID() });
    const root = `/v1/operator/fraud-flags/${id}`;
    const detail = await request(app.url).get(root).auth(operator, { type: 'bearer' }).expect(200);
    assert.equal(detail.body.score, decision.rule_score + decision.ai_applied_weight);
    if (!live) assert.deepEqual(detail.body.hits, []);
    assert.equal(detail.body.aiAssessment.status, 'SUCCEEDED');
    await request(app.url).get(root).auth(sender.token, { type: 'bearer' }).expect(403);
    await request(app.url)
      .post(`${root}/review`)
      .auth(operator, { type: 'bearer' })
      .send({ decision: 'FALSE_POSITIVE' })
      .expect(200);
    await request(app.url)
      .post(`${root}/review`)
      .auth(operator, { type: 'bearer' })
      .send({ decision: 'CONFIRMED_FRAUD' })
      .expect(409);
    const original = await eventFor(runner, id);
    const duplicate = { ...original, eventId: randomUUID() };
    await sqs.send(riskUrl, JSON.stringify(duplicate));
    await until(
      async () =>
        (
          await q("SELECT 1 FROM processed_events WHERE consumer='risk' AND event_id=$1", [
            duplicate.eventId,
          ])
        ).length === 1,
      'duplicate',
    );
    if (!live) assert.equal(calls, 1);
    await until(async () => {
      const [{ n }] = await q(
        'SELECT count(*)::int AS n FROM ai_gate_permits WHERE released_at IS NULL',
      );
      return n === 0;
    }, 'gate release');
    assert.equal((await q('SELECT requests::int AS n FROM ai_gate_days'))[0].n, 1);
    assert.deepEqual(
      await q('SELECT count(*)::int AS n FROM risk_decisions WHERE transfer_id=$1', [id]),
      [{ n: 1 }],
    );
    assert.deepEqual(
      await q(
        "SELECT count(*)::int AS n FROM audit_log WHERE action='fraud_flag.review' AND target_id=$1",
        [id],
      ),
      [{ n: 1 }],
    );
    assert.deepEqual((await checkLedgerInvariants(runner)).violations, []);
    console.log(
      `M-RSK-02 IDs (synthetic): transferId=${id}; correlationId=${String(original.correlationId)}`,
    );
    console.log(
      `M-RSK-02 PASS: HTTP transfer → outbox → ElasticMQ → worker → ${live ? 'OpenAI thật' : 'synthetic AI'} → durable decision and flag`,
    );
    if (live)
      console.log(
        `M-RSK-02 OpenAI: model=${decision.response_model}; probability=${decision.probability}; ruleScore=${decision.rule_score}; aiWeight=${decision.ai_applied_weight}`,
      );
    console.log(
      'M-RSK-02 PASS: operator detail 200; customer 403; review 200 then 409; redelivery one decision/one provider call',
    );
    console.log(
      `M-RSK-02 PASS: gate one request/released; review audit committed; ledger invariants unchanged${live ? '' : '; no external provider request'}`,
    );
  } finally {
    await parts?.consumer.onApplicationShutdown();
    await relay?.onApplicationShutdown();
    await app?.close();
    sqs?.onModuleDestroy();
    await source?.destroy();
    await db?.drop();
    if (provider?.listening)
      await new Promise<void>((resolve, reject) =>
        provider!.close(error => (error ? reject(error) : resolve())),
      );
    await mq?.stop();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

void main().catch(() => {
  console.error('M-RSK-02 FAIL: inspect isolated test prerequisites and assertions');
  process.exitCode = 1;
});
