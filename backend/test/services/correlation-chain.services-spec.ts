import { Logger } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, type EntityManager } from 'typeorm';
import type { DomainEvent } from '@common/events';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import { OutboxRelayService } from '@modules/outbox';
import { NotificationConsumer, dlqUrlFor } from '@modules/notification';
import { AuditService } from '@modules/audit';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startElasticMqContainer, type StartedElasticMq } from '../support/elasticmq.container';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';

type Row = Record<string, unknown>;

const pino = new PinoLogger({ pinoHttp: { level: 'silent' } } as never);

/** Fails once after its effect, like a database error at commit time, so SQS redelivers. */
class FlakyNotificationConsumer extends NotificationConsumer {
  failuresLeft = 0;
  protected override get retryBackoffSeconds(): number {
    return 0;
  }
  protected override async apply(event: DomainEvent, manager: EntityManager): Promise<void> {
    await super.apply(event, manager);
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('boom after the effect');
    }
  }
}

/**
 * DBS-134: the correlationId chosen by the server follows one operation through the API, the audit
 * log, the outbox, SQS and the consumer. Real HTTP app, PostgreSQL and ElasticMQ; the chain is
 * driven step by step (`relayOnce`, `consumeOnce(0)`), with no polling loop and no sleeps.
 */
describe('correlationId across API → outbox → SQS → consumer (real PostgreSQL + ElasticMQ)', () => {
  let mq: StartedElasticMq;
  let db: TempDatabase;
  let source: DataSource;
  let sqs: SqsClient;
  let relay: OutboxRelayService;
  let consumer: FlakyNotificationConsumer;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  let riskUrl: string;
  let notificationUrl: string;
  let operatorToken: string;
  const oldKey = process.env.AWS_ACCESS_KEY_ID;
  const oldSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const q = (sql: string, args: unknown[] = []): Promise<Row[]> =>
    db.runner.query(sql, args) as Promise<Row[]>;

  /** Reads every visible message with its attributes, acknowledging them when asked. */
  async function readAll(url: string, acknowledge: boolean) {
    const found: { body: Row; attribute: string | undefined }[] = [];
    for (;;) {
      const messages = await sqs.receive(url, { waitTimeSeconds: 1, visibilityTimeout: 30 });
      if (messages.length === 0) return found;
      for (const message of messages) {
        found.push({
          body: JSON.parse(message.Body!) as Row,
          attribute: message.MessageAttributes?.correlationId?.StringValue,
        });
        if (acknowledge) await sqs.acknowledge(url, message);
      }
    }
  }
  function deposit(
    accountId: string,
    key: string,
    headers: Record<string, string> = {},
  ): request.Test {
    return request(app.url)
      .post('/v1/operator/deposits')
      .auth(operatorToken, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .set(headers)
      .send({ toAccountId: accountId, amount: '5000000' });
  }
  const countBy = async (table: string, column: string, id: string) =>
    (
      (await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [id]))[0] as {
        n: number;
      }
    ).n;
  /** Captures what the consumer logs: the metadata object and the logging context at that moment. */
  function captureConsumerLogs() {
    const lines: { meta: Row; context: unknown; role: unknown }[] = [];
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((meta: unknown) => {
      const bindings = pino.logger.bindings();
      lines.push({ meta: meta as Row, context: bindings.correlationId, role: bindings.role });
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    mq = await startElasticMqContainer();
    riskUrl = new URL('/000000000000/risk-events', mq.endpoint).toString();
    notificationUrl = new URL('/000000000000/notification-events', mq.endpoint).toString();
    db = await createTempDatabase();
    await migrate(db.url);
    source = new DataSource({ type: 'postgres', url: db.url });
    await source.initialize();
    const tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    sqs = new SqsClient({ region: 'us-east-1', endpoint: mq.endpoint });
    const config = {
      region: 'us-east-1',
      endpoint: mq.endpoint,
      riskQueueUrl: riskUrl,
      notificationQueueUrl: notificationUrl,
    };
    relay = new OutboxRelayService(tx, sqs, config);
    consumer = new FlakyNotificationConsumer(tx, sqs, pino, config, new AuditService(tx));
    app = await startDepositApp(db.url);
    operatorToken = await app.issuer.token('operator', { sub: randomUUID() });
  });
  afterAll(async () => {
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
  beforeEach(async () => {
    consumer.failuresLeft = 0;
    await q('DELETE FROM outbox_events');
    await q('DELETE FROM processed_events');
    await q('DELETE FROM notification_log');
    for (const url of [riskUrl, notificationUrl, dlqUrlFor(notificationUrl)]) {
      await readAll(url, true);
    }
  });

  it('TC-134-04/05/06 the server id links audit, outbox, both queues and the notice; client ids go nowhere', async () => {
    const target = await seedDepositTarget(db.runner);
    const clientCorrelation = randomUUID();
    const clientRequest = randomUUID();
    const res = await deposit(target.accountId, randomUUID(), {
      'X-Correlation-Id': clientCorrelation,
      'X-Request-Id': clientRequest,
    }).expect(201);
    const id = String(res.headers['x-correlation-id']);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect([clientCorrelation, clientRequest]).not.toContain(id);

    // 1. API side: the same id in every table written by the request.
    for (const [table, column] of [
      ['audit_log', 'correlation_id'],
      ['outbox_events', 'correlation_id'],
      ['outbox_events', "payload->>'correlationId'"],
      ['transfers', 'correlation_id'],
    ]) {
      expect(await countBy(table, column, id)).toBe(1);
      for (const foreign of [clientCorrelation, clientRequest]) {
        expect(await countBy(table, column, foreign)).toBe(0);
      }
    }

    // 2. Relay: both queues get the event with the same id in body and attribute.
    expect(await relay.relayOnce()).toEqual({ published: 1 });
    const risk = await readAll(riskUrl, true);
    expect(risk.map(m => [m.body.correlationId, m.attribute])).toEqual([[id, id]]);
    const peek = await sqs.receive(notificationUrl, { waitTimeSeconds: 1, visibilityTimeout: 0 });
    expect(peek.map(m => m.MessageAttributes?.correlationId?.StringValue)).toEqual([id]);
    expect(peek.map(m => (JSON.parse(m.Body!) as Row).correlationId)).toEqual([id]);

    // 3. Consumer: the notice carries the id, and the worker log line is in that context.
    const capture = captureConsumerLogs();
    try {
      expect((await consumer.consumeOnce(0)).map(r => r.status)).toEqual(['acknowledged']);
    } finally {
      capture.restore();
    }
    const notice = await q('SELECT user_id, correlation_id FROM notification_log');
    expect(notice).toEqual([{ user_id: target.userId, correlation_id: id }]);
    expect(capture.lines).toEqual([
      expect.objectContaining({
        meta: expect.objectContaining({ correlationId: id }) as unknown,
        context: id,
        role: 'worker',
      }),
    ]);
  });

  it('TC-134-07 a lock links audit, event and notice by one id; the unlock is a different chain', async () => {
    const target = await seedDepositTarget(db.runner);
    const lock = await request(app.url)
      .post(`/v1/operator/accounts/${target.accountId}/lock`)
      .auth(operatorToken, { type: 'bearer' })
      .set('X-Correlation-Id', randomUUID())
      .send({ reason: 'CONFIRMED_FRAUD' })
      .expect(200);
    const unlock = await request(app.url)
      .post(`/v1/operator/accounts/${target.accountId}/unlock`)
      .auth(operatorToken, { type: 'bearer' })
      .send({ reason: 'OPERATOR_UNLOCK' })
      .expect(200);
    const lockId = String(lock.headers['x-correlation-id']);
    const unlockId = String(unlock.headers['x-correlation-id']);
    expect(lockId).not.toBe(unlockId);

    expect(await relay.relayOnce()).toEqual({ published: 2 });
    await consumer.consumeOnce(0);
    const notices = await q('SELECT message, correlation_id FROM notification_log ORDER BY id');
    expect(notices.map(n => n.correlation_id).sort()).toEqual([lockId, unlockId].sort());
    for (const id of [lockId, unlockId]) {
      expect(await countBy('audit_log', 'correlation_id', id)).toBeGreaterThanOrEqual(1);
      expect(await countBy('outbox_events', 'correlation_id', id)).toBe(1);
    }
    expect(JSON.stringify(notices)).not.toMatch(/CONFIRMED_FRAUD|gian lận/i);
  });

  it('TC-134-11 a failed attempt rolls back; the redelivery has the same id, one set of rows and its log', async () => {
    const target = await seedDepositTarget(db.runner);
    const res = await deposit(target.accountId, randomUUID()).expect(201);
    const id = String(res.headers['x-correlation-id']);
    await relay.relayOnce();
    await readAll(riskUrl, true);

    consumer.failuresLeft = 1;
    const capture = captureConsumerLogs();
    try {
      expect((await consumer.consumeOnce(0, 0)).map(r => r.status)).toEqual(['failed']);
      expect(await countBy('notification_log', 'correlation_id', id)).toBe(0);
      expect((await consumer.consumeOnce(0)).map(r => r.status)).toEqual(['acknowledged']);
    } finally {
      capture.restore();
    }
    expect(await countBy('notification_log', 'correlation_id', id)).toBe(1);
    expect(capture.lines.map(l => [l.meta.correlationId, l.context])).toEqual([[id, id]]);
  });

  it('TC-134-12 the same event delivered twice has one set of rows and one log line', async () => {
    const target = await seedDepositTarget(db.runner);
    const res = await deposit(target.accountId, randomUUID()).expect(201);
    const id = String(res.headers['x-correlation-id']);
    await relay.relayOnce();
    await readAll(riskUrl, true);
    const [first] = await readAll(notificationUrl, true);
    // What a relay crash between "send" and "mark published" produces: the event arrives twice.
    for (let i = 0; i < 2; i++) {
      await sqs.send(notificationUrl, JSON.stringify(first.body), { correlationId: id });
    }

    const capture = captureConsumerLogs();
    try {
      await consumer.consumeOnce(0);
      await consumer.consumeOnce(0);
    } finally {
      capture.restore();
    }
    expect(await countBy('notification_log', 'correlation_id', id)).toBe(1);
    expect(capture.lines).toHaveLength(1);
  });

  it('TC-134-13 a replay writes nothing new; a refused deposit is audited with its id and emits nothing', async () => {
    const target = await seedDepositTarget(db.runner);
    const key = randomUUID();
    const first = await deposit(target.accountId, key).expect(201);
    const replay = await deposit(target.accountId, key).expect(201);
    const replayId = String(replay.headers['x-correlation-id']);
    expect(replayId).not.toBe(String(first.headers['x-correlation-id']));
    expect(await countBy('audit_log', 'correlation_id', replayId)).toBe(0);
    expect(await countBy('outbox_events', 'correlation_id', replayId)).toBe(0);

    const locked = await seedDepositTarget(db.runner, 'LOCKED');
    const refused = await deposit(locked.accountId, randomUUID()).expect(422);
    const refusedId = String(refused.headers['x-correlation-id']);
    expect((refused.body as Row).errorCode).toBe('ACCOUNT_NOT_ACTIVE');
    expect(await countBy('audit_log', 'correlation_id', refusedId)).toBe(1);
    expect(await countBy('outbox_events', 'correlation_id', refusedId)).toBe(0);
    expect(await countBy('notification_log', 'correlation_id', refusedId)).toBe(0);
  });
});
