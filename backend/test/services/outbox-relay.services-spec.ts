import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import { OutboxRelayService } from '@modules/outbox';
import { RELAY_BATCH_SIZE, RELAY_IDLE_DELAY_MS } from '@modules/outbox/outbox-relay.service';
import { OutboxCleanupService } from '@modules/outbox/outbox-cleanup.service';
import { NotificationConsumer, dlqUrlFor } from '@modules/notification';
import { AuditService } from '@modules/audit';
import { ACCOUNT_LOCKED_SAMPLE, TRANSFER_SAMPLE } from '../support/event-samples';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startElasticMqContainer, type StartedElasticMq } from '../support/elasticmq.container';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

const silentPino = new PinoLogger({ pinoHttp: { level: 'silent' } } as never);

/**
 * Outbox relay and notification consumer against real PostgreSQL and a real SQS protocol server
 * (ElasticMQ). Needs DATABASE_URL (a PostgreSQL server) and Docker, like the other services specs.
 */
describe('outbox relay and notification consumer (real PostgreSQL + ElasticMQ)', () => {
  let mq: StartedElasticMq;
  let db: TempDatabase;
  let source: DataSource;
  let sqs: SqsClient;
  let relay: OutboxRelayService;
  let consumer: NotificationConsumer;
  let riskUrl: string;
  let notificationUrl: string;
  const oldKey = process.env.AWS_ACCESS_KEY_ID;
  const oldSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;

  const transferEvent = () => ({ ...TRANSFER_SAMPLE, eventId: randomUUID() });
  async function enqueue(event: Record<string, unknown>, type = String(event.eventType)) {
    await q(
      `INSERT INTO outbox_events(event_id,event_type,aggregate_id,payload,correlation_id)
       VALUES($1,$2,$3,$4::jsonb,$5)`,
      [event.eventId, type, randomUUID(), JSON.stringify(event), event.correlationId],
    );
  }
  async function drain(url: string): Promise<Record<string, unknown>[]> {
    const bodies: Record<string, unknown>[] = [];
    for (;;) {
      const messages = await sqs.receive(url, { waitTimeSeconds: 1, visibilityTimeout: 30 });
      if (messages.length === 0) return bodies;
      for (const message of messages) {
        bodies.push(JSON.parse(message.Body!) as Record<string, unknown>);
        await sqs.acknowledge(url, message);
      }
    }
  }

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    mq = await startElasticMqContainer();
    riskUrl = new URL('/000000000000/risk-events', mq.endpoint).toString();
    notificationUrl = new URL('/000000000000/notification-events', mq.endpoint).toString();
    db = await createTempDatabase();
    await migrate(db.url);
    for (const id of [TRANSFER_SAMPLE.fromUserId, TRANSFER_SAMPLE.toUserId]) {
      await q('INSERT INTO users(id,cognito_sub) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        id,
        randomUUID(),
      ]);
    }
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
    consumer = new NotificationConsumer(tx, sqs, silentPino, config, new AuditService(tx));
  });
  afterAll(async () => {
    sqs?.onModuleDestroy();
    await source?.destroy();
    await db?.drop();
    await mq?.stop();
    if (oldKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = oldKey;
    if (oldSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = oldSecret;
  });
  beforeEach(async () => {
    await q('DELETE FROM outbox_events');
    await q('DELETE FROM processed_events');
    await q('DELETE FROM notification_log');
    await drain(riskUrl);
    await drain(notificationUrl);
    await drain(dlqUrlFor(notificationUrl));
  });

  it('TC-OBX-01 routes each event to every queue that wants it, then marks it published', async () => {
    const transfer = transferEvent();
    const locked = { ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID() };
    await enqueue(transfer);
    await enqueue(locked);
    expect(await relay.relayOnce()).toEqual({ published: 2 });
    expect((await drain(riskUrl)).map(e => e.eventId)).toEqual([transfer.eventId]);
    expect((await drain(notificationUrl)).map(e => e.eventId).sort()).toEqual(
      [transfer.eventId, locked.eventId].sort(),
    );
    expect(await q('SELECT 1 FROM outbox_events WHERE published_at IS NULL')).toEqual([]);
    expect(await relay.relayOnce()).toEqual({ published: 0 });
    expect(await drain(riskUrl)).toEqual([]);
  });

  it('TC-OBX-02 two relays running at once never take the same event', async () => {
    const events = Array.from({ length: 20 }, transferEvent);
    for (const event of events) await enqueue(event);
    const results = await Promise.all([relay.relayOnce(10), relay.relayOnce(10)]);
    expect(results.reduce((sum, r) => sum + r.published, 0)).toBe(20);
    const sent = (await drain(notificationUrl)).map(e => e.eventId as string);
    expect(sent).toHaveLength(20);
    expect(new Set(sent)).toEqual(new Set(events.map(e => e.eventId)));
    expect(await drain(riskUrl)).toHaveLength(20);
  });

  it('TC-OBX-03 a failed send keeps that event pending and the others still go out', async () => {
    const events = [transferEvent(), transferEvent(), transferEvent()];
    for (const event of events) await enqueue(event);
    let calls = 0;
    const flaky = {
      send: (url: string, body: string, attributes: Record<string, string>) => {
        calls += 1;
        // Event 1 uses calls 1 and 2 (risk, notification); event 2 fails on its first send.
        if (calls === 3) return Promise.reject(new Error('queue unavailable'));
        return sqs.send(url, body, attributes);
      },
    } as unknown as SqsClient;
    const tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    const broken = new OutboxRelayService(tx, flaky, {
      region: 'us-east-1',
      endpoint: mq.endpoint,
      riskQueueUrl: riskUrl,
      notificationQueueUrl: notificationUrl,
    });
    const first = await broken.relayOnce();
    // DBS-91: the failing event stays, the one behind it is not blocked by it.
    expect(first.published).toBe(2);
    expect(first.failure).toBeInstanceOf(Error);
    const pending = await q('SELECT event_id FROM outbox_events WHERE published_at IS NULL');
    expect(pending.map(r => r.event_id)).toEqual([events[1].eventId]);
    // Nothing is lost: the healthy relay finishes the job, and the other events are not sent again.
    expect(await relay.relayOnce()).toEqual({ published: 1 });
    const seen = (await drain(notificationUrl)).map(e => e.eventId as string);
    expect(seen.sort()).toEqual(events.map(e => e.eventId).sort());
  });

  it('TC-OBX-04 an event type without a route stays pending and does not block the others', async () => {
    const mystery = { ...transferEvent(), eventType: 'MysteryHappened' };
    await enqueue(mystery);
    await enqueue(transferEvent());
    expect(await relay.relayOnce()).toEqual({ published: 1 });
    const pending = await q('SELECT event_type FROM outbox_events WHERE published_at IS NULL');
    expect(pending).toEqual([{ event_type: 'MysteryHappened' }]);
  });

  it('TC-OBX-05 cleanup removes only published rows and processed marks past the retention', async () => {
    const old = transferEvent(),
      fresh = transferEvent(),
      pending = transferEvent();
    for (const event of [old, fresh, pending]) await enqueue(event);
    await q(`UPDATE outbox_events SET published_at = now() - interval '8 days' WHERE event_id=$1`, [
      old.eventId,
    ]);
    await q(`UPDATE outbox_events SET published_at = now() WHERE event_id=$1`, [fresh.eventId]);
    await q(
      `INSERT INTO processed_events(consumer,event_id,processed_at)
       VALUES('notification',$1,now() - interval '8 days'),('notification',$2,now())`,
      [randomUUID(), randomUUID()],
    );
    const cleanup = new OutboxCleanupService(
      new TransactionService(source, {
        lockTimeoutMs: 2000,
        statementTimeoutMs: 5000,
        idleInTransactionTimeoutMs: 10000,
      } as never),
      {
        idempotencyKeyRetentionDays: 7,
        outbox: { retentionDays: 7, processedEventsRetentionDays: 7 },
      } as never,
    );
    expect(await cleanup.cleanOnce({ pauseMs: 0 })).toMatchObject({ outbox: 1, processed: 1 });
    const left = await q('SELECT event_id FROM outbox_events ORDER BY id');
    expect(left.map(r => r.event_id).sort()).toEqual([fresh.eventId, pending.eventId].sort());
    expect(await q('SELECT 1 FROM processed_events')).toHaveLength(1);
  });

  /** A relay on its own connection (like another worker task) whose `send` can be held open. */
  function relayWith(send?: SqsClient['send']): OutboxRelayService {
    const tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    const wrapped = (send ? { send } : sqs) as unknown as SqsClient;
    return new OutboxRelayService(tx, wrapped, {
      region: 'us-east-1',
      endpoint: mq.endpoint,
      riskQueueUrl: riskUrl,
      notificationQueueUrl: notificationUrl,
    });
  }
  function gate() {
    let release!: () => void;
    const open = new Promise<void>(resolve => (release = resolve));
    return { open, release };
  }

  it('TC-90-03 two relays really overlap: the second skips the rows the first still holds', async () => {
    const events = Array.from({ length: 20 }, transferEvent);
    for (const event of events) await enqueue(event);
    const hold = gate();
    let entered!: () => void;
    const inside = new Promise<void>(resolve => (entered = resolve));
    const slow = relayWith(async (url, body, attributes) => {
      entered();
      await hold.open;
      return sqs.send(url, body, attributes);
    });
    const first = slow.relayOnce(10);
    await inside; // relay A is inside SQS with 10 rows locked
    expect(await relayWith().relayOnce(10)).toEqual({ published: 10 });
    const secondIds = (
      await q('SELECT event_id FROM outbox_events WHERE published_at IS NOT NULL')
    ).map(r => r.event_id);
    expect(secondIds.sort()).toEqual(
      events
        .slice(10)
        .map(e => e.eventId)
        .sort(),
    );
    hold.release();
    expect(await first).toEqual({ published: 10 });
    expect(await q('SELECT 1 FROM outbox_events WHERE published_at IS NULL')).toEqual([]);
    const seen = (await drain(riskUrl)).map(e => e.eventId as string);
    expect(seen).toHaveLength(20);
    expect(new Set(seen)).toEqual(new Set(events.map(e => e.eventId)));
    await drain(notificationUrl);
  });

  it('TC-90-04 messages are sent before any row is visible as published', async () => {
    const events = [transferEvent(), transferEvent(), transferEvent()];
    for (const event of events) await enqueue(event);
    const hold = gate();
    let entered!: () => void;
    const inside = new Promise<void>(resolve => (entered = resolve));
    let sent = 0;
    let calls = 0;
    const slow = relayWith(async (url, body, attributes) => {
      calls += 1;
      if (calls === 6) {
        // The last send of the last event: everything before it is already in the queues.
        entered();
        await hold.open;
      }
      await sqs.send(url, body, attributes);
      sent += 1;
    });
    const run = slow.relayOnce();
    await inside;
    expect(sent).toBe(5);
    // From another connection: nothing is published yet although five messages are out.
    expect(await q('SELECT 1 FROM outbox_events WHERE published_at IS NOT NULL')).toEqual([]);
    hold.release();
    expect(await run).toEqual({ published: 3 });
    expect(await q('SELECT 1 FROM outbox_events WHERE published_at IS NULL')).toEqual([]);
    await drain(riskUrl);
    await drain(notificationUrl);
  });

  it('TC-90-05 the poll interval is within one second and the batch is the 100 of ADR-03', () => {
    expect(RELAY_IDLE_DELAY_MS).toBeLessThanOrEqual(1000);
    expect(RELAY_BATCH_SIZE).toBe(100);
  });

  it('TC-90-09 a full batch is 100 events and the rest follow on the next run', async () => {
    const events = Array.from({ length: 120 }, transferEvent);
    for (const event of events) await enqueue(event);
    expect(await relay.relayOnce()).toEqual({ published: 100 });
    expect(await q('SELECT 1 FROM outbox_events WHERE published_at IS NULL')).toHaveLength(20);
    expect(await relay.relayOnce()).toEqual({ published: 20 });
    expect(await drain(riskUrl)).toHaveLength(120);
    await drain(notificationUrl);
  });

  async function untilPublished(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await q('SELECT 1 FROM outbox_events WHERE published_at IS NULL')).length === 0) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  }
  async function inRole(role: string, run: () => Promise<void>): Promise<void> {
    const previous = process.env.APP_ROLE;
    process.env.APP_ROLE = role;
    try {
      await run();
    } finally {
      if (previous === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previous;
    }
  }

  it('TC-90-06 in the worker role the relay runs by itself and stops on shutdown', async () => {
    const worker = relayWith();
    const first = transferEvent();
    await inRole('worker', async () => {
      worker.onApplicationBootstrap();
      try {
        await enqueue(first);
        expect(await untilPublished(3000)).toBe(true);
      } finally {
        await worker.onApplicationShutdown();
      }
    });
    expect((await drain(riskUrl)).map(e => e.eventId)).toEqual([first.eventId]);
    expect((await drain(notificationUrl)).map(e => e.eventId)).toEqual([first.eventId]);
    // Stopped: a new event is not taken any more.
    await enqueue(transferEvent());
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(await q('SELECT 1 FROM outbox_events WHERE published_at IS NULL')).toHaveLength(1);
  });

  it('TC-90-07 in the api role the relay does not run', async () => {
    const api = relayWith();
    await inRole('api', async () => {
      api.onApplicationBootstrap();
      try {
        await enqueue(transferEvent());
        await new Promise(resolve => setTimeout(resolve, 1500));
        expect(await q('SELECT 1 FROM outbox_events WHERE published_at IS NULL')).toHaveLength(1);
      } finally {
        await api.onApplicationShutdown();
      }
    });
  });

  it('TC-90-08 a real deposit and transfer reach each queue exactly once', async () => {
    const app = await startDepositApp(db.url);
    try {
      const sender = await seedDepositTarget(db.runner);
      const receiver = await seedDepositTarget(db.runner);
      const operator = await app.issuer.token('operator', { sub: randomUUID() });
      const customer = await app.issuer.token('customer', { sub: sender.sub });
      await request(app.url)
        .post('/v1/operator/deposits')
        .auth(operator, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ toAccountId: sender.accountId, amount: '1000000' })
        .expect(201);
      const transfer = await request(app.url)
        .post('/v1/transfers')
        .auth(customer, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({
          fromAccountId: sender.accountId,
          toAccountId: receiver.accountId,
          amount: '300000',
        })
        .expect(201);
      const events = await q(
        `SELECT payload->>'type' AS type, payload->>'transferId' AS transfer_id,
                payload->>'eventId' AS event_id FROM outbox_events ORDER BY id`,
      );
      expect(events.map(e => e.type)).toEqual(['DEPOSIT', 'TRANSFER']);
      expect(events[1].transfer_id).toBe((transfer.body as { transferId: string }).transferId);

      expect(await relay.relayOnce()).toEqual({ published: 2 });
      expect(await relay.relayOnce()).toEqual({ published: 0 });
      for (const url of [riskUrl, notificationUrl]) {
        const bodies = await drain(url);
        expect(bodies.map(b => b.eventId).sort()).toEqual(events.map(e => e.event_id).sort());
        expect(bodies.map(b => b.type).sort()).toEqual(['DEPOSIT', 'TRANSFER']);
      }
      expect((await checkLedgerInvariants(db.runner)).status).toBe('PASS');
    } finally {
      await app.close();
    }
  });

  it('TC-NTF-01 end to end: relayed event is handled once even when delivered twice', async () => {
    const event = transferEvent();
    await enqueue(event);
    await relay.relayOnce();
    // The same event again, as at-least-once delivery allows.
    await sqs.send(notificationUrl, JSON.stringify(event));
    const results = await consumer.consumeOnce(1);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 3; i++) await consumer.consumeOnce(1);
    const marks = await q('SELECT consumer,event_id FROM processed_events');
    expect(marks).toEqual([{ consumer: 'notification', event_id: event.eventId }]);
    const logs = await q('SELECT event_id,kind,user_id FROM notification_log ORDER BY user_id');
    // One row for the sender and one for the recipient (DBS-102), not one per delivery.
    expect(logs).toEqual(
      [TRANSFER_SAMPLE.fromUserId, TRANSFER_SAMPLE.toUserId]
        .sort()
        .map(user_id => ({ event_id: event.eventId, kind: 'transfer_completed', user_id })),
    );
    // Both copies were acknowledged: nothing is left to redeliver.
    expect(await drain(notificationUrl)).toEqual([]);
  });

  it('TC-NTF-02 an invalid event goes to the dead-letter queue at once and leaves no mark (DBS-101)', async () => {
    await sqs.send(notificationUrl, JSON.stringify({ eventType: 'TransferCompleted' }));
    const [result] = await consumer.consumeOnce(1);
    expect(result.status).toBe('dead-lettered');
    expect(await q('SELECT 1 FROM processed_events')).toEqual([]);
    expect(await drain(dlqUrlFor(notificationUrl))).toEqual([{ eventType: 'TransferCompleted' }]);
  });

  it('TC-NTF-03 a body that is not JSON goes straight to the dead-letter queue', async () => {
    await sqs.send(notificationUrl, 'this is not json');
    const [result] = await consumer.consumeOnce(1);
    expect(result.status).toBe('dead-lettered');
    const [dead] = await sqs.receive(dlqUrlFor(notificationUrl), {
      waitTimeSeconds: 1,
      visibilityTimeout: 0,
    });
    expect(dead.Body).toBe('this is not json');
  });
});
