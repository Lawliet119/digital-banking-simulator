import { randomUUID } from 'node:crypto';
import { installSilentRootLogger } from '../support/silent-root-logger';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import { AuditService } from '@modules/audit';
import type { AuditEntriesPage, AuditEntry } from '@modules/audit/audit-search.query';
import { NotificationConsumer, dlqUrlFor } from '@modules/notification';
import { OutboxRelayService } from '@modules/outbox';
import { startDepositApp } from '../support/deposit-app';
import { startElasticMqContainer, type StartedElasticMq } from '../support/elasticmq.container';
import { buildRiskConsumer, riskFixtures, type RiskConsumerParts } from '../support/risk-consumer';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { expectLedgerInvariantsAfterEach } from '../support/ledger-invariants';

type Row = Record<string, unknown>;

installSilentRootLogger();
const CHAIN = ['transfer', 'notification.sent', 'fraud.flagged', 'fraud_flag.review'];

/**
 * DBS-135 (AC-8.2, NFR-AUD-02): one transfer, one code. A completed, flagged and reviewed transfer
 * is traced by the auditor with `GET /v1/audit/entries?correlationId=` and shows the whole chain.
 * Real HTTP app, PostgreSQL and ElasticMQ; relay and both consumers are driven step by step
 * (`relayOnce`, `consumeOnce(0)`), no polling loop and no sleeps.
 */
describe('DBS-135 an auditor traces one transfer end to end by its correlationId', () => {
  let mq: StartedElasticMq;
  let db: TempDatabase;
  let source: DataSource;
  let sqs: SqsClient;
  let relay: OutboxRelayService;
  let notification: NotificationConsumer;
  let risk: RiskConsumerParts;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  let fx: ReturnType<typeof riskFixtures>;
  let riskUrl: string;
  let notificationUrl: string;
  let operatorToken: string;
  let auditorToken: string;
  const saved = {
    key: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
  };
  const q = (sql: string, args: unknown[] = []): Promise<Row[]> =>
    db.runner.query(sql, args) as Promise<Row[]>;
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  async function drain(url: string) {
    for (;;) {
      const messages = await sqs.receive(url, { waitTimeSeconds: 1, visibilityTimeout: 30 });
      if (messages.length === 0) return;
      for (const message of messages) await sqs.acknowledge(url, message);
    }
  }

  /** An (21.000.000d) sends 20.000.000d to Binh: R3 + R6 = 65, a MEDIUM flag (rule-only). */
  async function completedAndFlagged(headers: Record<string, string> = {}) {
    const an = await fx.customer('Trần Văn An');
    const binh = await fx.customer('Nguyễn Thị Bình');
    await fx.deposit(an.accounts[0], '21000000');
    // The deposit has its own event: relay it and discard both copies so the transfer stands alone.
    await relay.relayOnce();
    await drain(riskUrl);
    await drain(notificationUrl);
    const res = await request(app.url)
      .post('/v1/transfers')
      .auth(an.token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .set(headers)
      .send({ fromAccountId: an.accounts[0], toAccountId: binh.accounts[0], amount: '20000000' })
      .expect(201);
    const transferId = String((res.body as Row).transferId);
    const code = String(res.headers['x-correlation-id']);
    expect(await relay.relayOnce()).toEqual({ published: 1 });
    expect((await notification.consumeOnce(0)).map(r => r.status)).toEqual(['acknowledged']);
    expect((await risk.consumer.consumeOnce(0)).map(r => r.status)).toEqual(['acknowledged']);
    return { transferId, code };
  }
  const review = (transferId: string, headers: Record<string, string> = {}) =>
    request(app.url)
      .post(`/v1/operator/fraud-flags/${transferId}/review`)
      .auth(operatorToken, { type: 'bearer' })
      .set(headers)
      .send({ decision: 'CONFIRMED_FRAUD', note: 'Đã gọi xác minh với khách hàng' });
  const lookup = (code: string) =>
    request(app.url)
      .get('/v1/audit/entries')
      .query({ correlationId: code })
      .auth(auditorToken, { type: 'bearer' });
  async function chain(code: string): Promise<AuditEntry[]> {
    const res = await lookup(code).expect(200);
    return (res.body as AuditEntriesPage).entries;
  }

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    mq = await startElasticMqContainer();
    riskUrl = new URL('/000000000000/risk-events', mq.endpoint).toString();
    notificationUrl = new URL('/000000000000/notification-events', mq.endpoint).toString();
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({
      type: 'postgres',
      url: db.url,
      extra: { max: 10 },
    }).initialize();
    sqs = new SqsClient({ region: 'us-east-1', endpoint: mq.endpoint });
    const tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    const config = {
      region: 'us-east-1',
      endpoint: mq.endpoint,
      riskQueueUrl: riskUrl,
      notificationQueueUrl: notificationUrl,
    };
    relay = new OutboxRelayService(tx, sqs, config);
    notification = new NotificationConsumer(tx, sqs, config, new AuditService(tx));
    risk = buildRiskConsumer(source, { sqs, queueUrl: riskUrl });
    app = await startDepositApp(db.url, { fraud: true, audit: true });
    operatorToken = await app.issuer.token('operator', { sub: randomUUID() });
    auditorToken = await app.issuer.token('auditor', { sub: randomUUID() });
    fx = riskFixtures(app, operatorToken);
  });
  afterAll(async () => {
    try {
      await app?.close();
      sqs?.onApplicationShutdown();
      await source?.destroy();
      await db?.drop();
      await mq?.stop();
    } finally {
      restore('AWS_ACCESS_KEY_ID', saved.key);
      restore('AWS_SECRET_ACCESS_KEY', saved.secret);
    }
  });
  beforeEach(async () => {
    for (const url of [riskUrl, notificationUrl, dlqUrlFor(notificationUrl)]) await drain(url);
  });

  expectLedgerInvariantsAfterEach(() => source);

  it('TC-135-01/02/03 transfer → notice → flag → review: four lines under one code, no fraud detail leaks', async () => {
    const attacker = randomUUID();
    const { transferId, code } = await completedAndFlagged({ 'X-Correlation-Id': attacker });
    expect(code).toMatch(/^[0-9a-f-]{36}$/);
    expect(code).not.toBe(attacker);

    const reviewed = await review(transferId, { 'X-Correlation-Id': attacker }).expect(200);
    const reviewRequestId = String(reviewed.headers['x-correlation-id']);
    expect(reviewRequestId).not.toBe(code); // TC-135-03: the request id is not the chain code
    expect([code, reviewRequestId]).not.toContain(attacker);

    const entries = await chain(code);
    expect(entries.map(e => e.action).sort()).toEqual([...CHAIN].sort());
    expect(entries.every(e => e.correlationId === code && e.outcome === 'SUCCESS')).toBe(true);
    expect(entries.every(e => e.target.id === transferId)).toBe(true);
    // Newest first: the review closes the chain, the request opens it.
    expect(entries[0].action).toBe('fraud_flag.review');
    expect(entries[entries.length - 1].action).toBe('transfer');

    // TC-135-02 and the metadata of TC-135-03.
    const by = (action: string) => entries.find(e => e.action === action)!;
    expect(by('transfer').metadata).toEqual({ id: expect.any(String) as unknown });
    expect(by('notification.sent').metadata).toEqual({ count: 2 });
    expect(by('fraud.flagged').metadata).toEqual({ count: 2 });
    expect(by('fraud_flag.review').metadata).toEqual({
      reason: 'CONFIRMED_FRAUD',
      id: reviewRequestId,
    });
    const text = JSON.stringify(entries);
    expect(text).not.toMatch(/Đã gọi xác minh|riskLevel|score|"R[1-6]"/);
    // No line anywhere carries the client's own value.
    expect(await q('SELECT 1 FROM audit_log WHERE correlation_id = $1', [attacker])).toEqual([]);
  });

  it('BL-226 an operator views the flag before reviewing: the view is a step of the chain, in order', async () => {
    const { transferId, code } = await completedAndFlagged();
    const viewed = await request(app.url)
      .get(`/v1/operator/fraud-flags/${transferId}`)
      .auth(operatorToken, { type: 'bearer' })
      .expect(200);
    const viewRequestId = String(viewed.headers['x-correlation-id']);
    expect(viewRequestId).not.toBe(code);
    const reviewed = await review(transferId).expect(200);

    const entries = await chain(code);
    // Newest first: review, view, then the worker lines (their relative order is not promised),
    // and the transfer request opens the chain.
    expect(entries).toHaveLength(CHAIN.length + 1);
    expect(entries.every(e => e.correlationId === code && e.target.id === transferId)).toBe(true);
    expect(entries[0].action).toBe('fraud_flag.review');
    expect(entries[1].action).toBe('fraud_flag.view');
    expect(entries[entries.length - 1].action).toBe('transfer');
    expect(entries.map(e => e.action).sort()).toEqual([...CHAIN, 'fraud_flag.view'].sort());
    // The view keeps the id of its own request, as the review does.
    expect(entries[1].metadata).toEqual({ id: viewRequestId });
    expect(entries[0].metadata).toEqual({
      reason: 'CONFIRMED_FRAUD',
      id: String(reviewed.headers['x-correlation-id']),
    });
    expect(JSON.stringify(entries)).not.toMatch(/riskLevel|score|"R[1-6]"|probability/);
    // The request's own code is not a chain code: nothing is filed under it.
    expect((await chain(viewRequestId)).filter(e => e.action === 'fraud_flag.view')).toEqual([]);
  });

  it('TC-135-04 an unknown code finds nothing; looking the chain up again changes nothing', async () => {
    const { transferId, code } = await completedAndFlagged();
    await review(transferId).expect(200);
    const unknown = await lookup(randomUUID()).expect(200);
    expect((unknown.body as AuditEntriesPage).entries).toEqual([]);
    expect(await chain(code)).toHaveLength(4);
    expect(await chain(code)).toHaveLength(4); // the lookups themselves are audited elsewhere
  });

  it('TC-135-05 a second review is refused with FLAG_ALREADY_REVIEWED and adds no line to the chain', async () => {
    const { transferId, code } = await completedAndFlagged();
    await review(transferId).expect(200);
    const again = await review(transferId).expect(409);
    expect((again.body as Row).errorCode).toBe('FLAG_ALREADY_REVIEWED');
    expect(await chain(code)).toHaveLength(4);
  });
});
