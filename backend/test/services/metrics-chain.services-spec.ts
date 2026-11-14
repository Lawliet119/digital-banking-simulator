import { randomUUID } from 'node:crypto';
import { installSilentRootLogger } from '../support/silent-root-logger';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { MetricsService } from '@common/metrics';
import type { EmfDocument } from '@common/metrics/emf';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import { OutboxRelayService } from '@modules/outbox';
import { OUTBOX_AGE_METRIC, OutboxAgeGauge } from '@modules/outbox/outbox-age.gauge';
import { startElasticMqContainer, type StartedElasticMq } from '../support/elasticmq.container';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

installSilentRootLogger();

/**
 * DBS-144: the metrics of a real operation. A deposit through the HTTP app (measured by the same
 * middleware `main.ts` mounts), its outbox row waiting, the relay moving it through ElasticMQ, and
 * the gauge following. Every EMF line the process writes is read back: valid for CloudWatch, and
 * free of any id, token or subject.
 */
describe('metrics across API, outbox and relay (real PostgreSQL + ElasticMQ)', () => {
  let mq: StartedElasticMq;
  let db: TempDatabase;
  let source: DataSource;
  let sqs: SqsClient;
  let relay: OutboxRelayService;
  let metrics: MetricsService;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  const docs: EmfDocument[] = [];
  const oldKey = process.env.AWS_ACCESS_KEY_ID;
  const oldSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;
  const names = (doc: EmfDocument): string[] =>
    doc._aws.CloudWatchMetrics[0].Metrics.map(m => m.Name);
  const gaugeValues = (): unknown[] =>
    docs.filter(d => names(d).includes(OUTBOX_AGE_METRIC)).map(d => d[OUTBOX_AGE_METRIC]);

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    mq = await startElasticMqContainer();
    const riskUrl = new URL('/000000000000/risk-events', mq.endpoint).toString();
    const notificationUrl = new URL('/000000000000/notification-events', mq.endpoint).toString();
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    const tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    sqs = new SqsClient({ region: 'us-east-1', endpoint: mq.endpoint });
    relay = new OutboxRelayService(tx, sqs, {
      region: 'us-east-1',
      endpoint: mq.endpoint,
      riskQueueUrl: riskUrl,
      notificationQueueUrl: notificationUrl,
    });
    metrics = new MetricsService(
      { enabled: true, flushMs: 600_000 },
      { role: 'both' } as never,
      doc => docs.push(doc),
    );
    new OutboxAgeGauge(tx, metrics).onModuleInit();
    await metrics.start();
    app = await startDepositApp(db.url, { metrics: metrics.httpMiddleware() });
  });
  afterAll(async () => {
    await metrics?.onApplicationShutdown();
    await app?.close();
    sqs?.onApplicationShutdown();
    await source?.destroy();
    await db?.drop();
    await mq?.stop();
    if (oldKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = oldKey;
    if (oldSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = oldSecret;
  });

  it('TC-144-12 a deposit is measured by its route, the waiting outbox row ages, the relay brings it back to 0', async () => {
    const operatorSub = randomUUID();
    const operatorToken = await app.issuer.token('operator', { sub: operatorSub });
    const target = await seedDepositTarget(db.runner);

    await request(app.url)
      .post('/v1/operator/deposits')
      .auth(operatorToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: target.accountId, amount: '5000000' })
      .expect(201);
    // Input row of the thing under test: the event waited 30 s for the relay.
    await q("UPDATE outbox_events SET created_at = created_at - interval '30 seconds'");

    await metrics.flush();
    const counters = docs.find(
      d => d.Route === '/v1/operator/deposits' && names(d).includes('http_requests_total'),
    );
    expect(counters).toMatchObject({
      Method: 'POST',
      http_requests_total: 1,
      http_5xx_total: 0,
      http_aborted_total: 0,
    });
    const latency = docs.find(
      d => d.Route === '/v1/operator/deposits' && names(d).includes('http_request_duration_ms'),
    );
    expect(latency?.http_request_duration_ms as number[]).toHaveLength(1);
    const waiting = gaugeValues().at(-1) as number;
    expect(waiting).toBeGreaterThanOrEqual(30);
    expect(waiting).toBeLessThan(40);

    expect(await relay.relayOnce()).toEqual({ published: 1 });
    docs.length = 0;
    await metrics.flush();
    expect(gaugeValues()).toEqual([0]);
  });

  it('TC-144-12 every line is valid for CloudWatch and holds no id, subject or token', async () => {
    docs.length = 0;
    const sub = randomUUID();
    const token = await app.issuer.token('operator', { sub });
    await request(app.url).get('/v1/identity/me').auth(token, { type: 'bearer' });
    await request(app.url).get(`/v1/accounts/${randomUUID()}`).expect(401);
    await metrics.flush();

    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      expect(doc._aws.CloudWatchMetrics[0].Namespace).toBe('DBS/Backend');
      for (const name of names(doc)) {
        const value = doc[name];
        expect(typeof value === 'number' || (Array.isArray(value) && value.length <= 100)).toBe(
          true,
        );
      }
    }
    const text = JSON.stringify(docs);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text).not.toContain(sub);
    expect(text).not.toContain(token);
    expect(text).not.toContain('eyJ');
  });
});
