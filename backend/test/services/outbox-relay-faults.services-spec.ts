import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import { OutboxRelayService } from '@modules/outbox';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startElasticMqContainer, type StartedElasticMq } from '../support/elasticmq.container';

/**
 * DBS-91: the outbox relay under failure, against real PostgreSQL and a real SQS protocol server.
 * Needs DATABASE_URL (a PostgreSQL server) and Docker, like the other services specs.
 */
describe('outbox relay under failure (real PostgreSQL + ElasticMQ)', () => {
  let mq: StartedElasticMq;
  let db: TempDatabase;
  let source: DataSource;
  let sqs: SqsClient;
  let riskUrl: string;
  let notificationUrl: string;
  const oldKey = process.env.AWS_ACCESS_KEY_ID;
  const oldSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;

  const transferEvent = () => ({ ...TRANSFER_SAMPLE, eventId: randomUUID() });
  type Send = SqsClient['send'];
  const http = (status: number) =>
    Object.assign(new Error(`http ${status}`), { $metadata: { httpStatusCode: status } });
  const idOf = (body: string) => (JSON.parse(body) as { eventId: string }).eventId;

  async function enqueue(event: Record<string, unknown>) {
    await q(
      `INSERT INTO outbox_events(event_id,event_type,aggregate_id,payload,correlation_id)
       VALUES($1,$2,$3,$4::jsonb,$5)`,
      [event.eventId, event.eventType, randomUUID(), JSON.stringify(event), event.correlationId],
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
  function relayWith(send?: Send): OutboxRelayService {
    const tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    return new OutboxRelayService(tx, (send ? { send } : sqs) as unknown as SqsClient, {
      region: 'us-east-1',
      endpoint: mq.endpoint,
      riskQueueUrl: riskUrl,
      notificationQueueUrl: notificationUrl,
    });
  }
  const pendingIds = async () =>
    (await q('SELECT event_id FROM outbox_events WHERE published_at IS NULL ORDER BY id')).map(
      r => r.event_id as string,
    );
  function gate() {
    let release!: () => void;
    const open = new Promise<void>(resolve => (release = resolve));
    return { open, release };
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
    sqs = new SqsClient({ region: 'us-east-1', endpoint: mq.endpoint });
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
    await drain(riskUrl);
    await drain(notificationUrl);
  });

  it('TC-91-04 permanently failing events at the head are parked and the others go through', async () => {
    const poison = Array.from({ length: 4 }, transferEvent);
    const good = Array.from({ length: 6 }, transferEvent);
    for (const event of [...poison, ...good]) await enqueue(event);
    const bad = new Set<string>(poison.map(e => e.eventId));
    const attempted: string[] = [];
    const relay = relayWith(async (url, body, attributes) => {
      attempted.push(idOf(body));
      if (bad.has(idOf(body))) throw http(400);
      return sqs.send(url, body, attributes);
    });
    let clock = 1_000_000;
    const now = () => clock;

    // One run: more than three poison events at the head do not block the six good ones.
    const first = await relay.relayOnce(100, { now });
    expect(first.published).toBe(6);
    expect((await pendingIds()).sort()).toEqual([...bad].sort());
    expect(first.failure).toBeDefined();

    // Parked: the next runs inside the pause do not touch them at all.
    attempted.length = 0;
    clock += 1_000;
    expect(await relay.relayOnce(100, { now })).toEqual({ published: 0 });
    expect(attempted).toEqual([]);

    // After the pause they are tried again, and the pause doubles.
    clock += 31_000;
    await relay.relayOnce(100, { now });
    expect(new Set(attempted)).toEqual(bad);
    attempted.length = 0;
    clock += 40_000; // 40 s into a 60 s pause
    await relay.relayOnce(100, { now });
    expect(attempted).toEqual([]);
    clock += 30_000; // past the 60 s pause
    await relay.relayOnce(100, { now });
    expect(new Set(attempted)).toEqual(bad);
    expect((await drain(riskUrl)).length).toBe(6);
    await drain(notificationUrl);
  });

  it('TC-91-05 when every send fails with a transient error the batch stops after three', async () => {
    for (const event of Array.from({ length: 20 }, transferEvent)) await enqueue(event);
    let calls = 0;
    const relay = relayWith(() => {
      calls += 1;
      return Promise.reject(new Error('socket hang up'));
    });
    const result = await relay.relayOnce();
    expect(calls).toBe(3);
    expect(result.published).toBe(0);
    expect(result.failure).toBeInstanceOf(Error);
    expect(await pendingIds()).toHaveLength(20);
  });

  it('TC-91-07 a failure on the second queue keeps the event and sends the first copy again', async () => {
    const events = [transferEvent(), transferEvent(), transferEvent()];
    for (const event of events) await enqueue(event);
    let calls = 0;
    const relay = relayWith(async (url, body, attributes) => {
      calls += 1;
      // Event 2 reaches the risk queue (call 3) and fails on the notification queue (call 4).
      if (calls === 4) throw new Error('socket hang up');
      return sqs.send(url, body, attributes);
    });
    const first = await relay.relayOnce();
    expect(first.published).toBe(2);
    expect(await pendingIds()).toEqual([events[1].eventId]);
    expect(await relayWith().relayOnce()).toEqual({ published: 1 });
    const risk = (await drain(riskUrl)).map(e => e.eventId as string);
    expect(risk.filter(id => id === events[1].eventId)).toHaveLength(2); // the duplicate
    expect(risk.filter(id => id === events[0].eventId)).toHaveLength(1);
    expect(risk.filter(id => id === events[2].eventId)).toHaveLength(1);
    const notification = (await drain(notificationUrl)).map(e => e.eventId as string);
    expect(notification.sort()).toEqual(events.map(e => e.eventId).sort());
  });

  describe('timeouts', () => {
    let silent: Server;
    let silentUrl: string;
    beforeAll(async () => {
      // Accepts the request and never answers.
      silent = createServer(() => undefined);
      await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
      silentUrl = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      silent.closeAllConnections();
      await new Promise<void>(resolve => silent.close(() => resolve()));
    });

    it('TC-91-08 a send that never answers is given up on and counts as a transient failure', async () => {
      const stuck = new SqsClient({ region: 'us-east-1', endpoint: silentUrl });
      try {
        const started = Date.now();
        await expect(
          stuck.send(`${silentUrl}/000000000000/risk-events`, '{}', {}, { timeoutMs: 200 }),
        ).rejects.toBeDefined();
        expect(Date.now() - started).toBeLessThan(2000);

        const event = transferEvent();
        await enqueue(event);
        const relay = relayWith((url, body, attributes, options) =>
          stuck.send(url.replace(mq.endpoint, silentUrl), body, attributes, options),
        );
        const result = await relay.relayOnce(100, { sendTimeoutMs: 200 });
        expect(result.published).toBe(0);
        expect(result.failure).toBeDefined();
        expect(await pendingIds()).toEqual([event.eventId]);
      } finally {
        stuck.onModuleDestroy();
      }
    });

    it('a message that arrived while the client gave up is sent again later (duplicate, same eventId)', async () => {
      const event = transferEvent();
      await enqueue(event);
      const relay = relayWith(async (url, body, attributes, options) => {
        await sqs.send(url, body, attributes); // SQS accepted it ...
        const signal = AbortSignal.timeout(options?.timeoutMs ?? 100);
        await new Promise<void>((_, reject) =>
          // ... but the answer never comes back in time.
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      });
      const first = await relay.relayOnce(100, { sendTimeoutMs: 100 });
      expect(first.published).toBe(0);
      expect(await pendingIds()).toEqual([event.eventId]);
      expect(await relayWith().relayOnce()).toEqual({ published: 1 });
      const risk = (await drain(riskUrl)).map(e => e.eventId);
      expect(risk).toEqual([event.eventId, event.eventId]);
      await drain(notificationUrl);
    });
  });

  it('TC-91-09 a batch over its time budget stops, commits what it sent and goes on at once', async () => {
    const events = Array.from({ length: 5 }, transferEvent);
    for (const event of events) await enqueue(event);
    let clock = 0;
    const slow = relayWith(async (url, body, attributes) => {
      clock += 150; // every send takes 150 ms; an event is two sends
      return sqs.send(url, body, attributes);
    });
    const now = () => clock;
    const first = await slow.relayOnce(100, { budgetMs: 300, now });
    expect(first.truncated).toBe(true);
    expect(first.published).toBe(1);
    // Same budget and a failing send in the same batch: both facts are reported.
    clock = 0;
    let calls = 0;
    const mixed = relayWith(async (url, body, attributes) => {
      calls += 1;
      clock += 150;
      if (calls === 3) throw new Error('socket hang up');
      return sqs.send(url, body, attributes);
    });
    const both = await mixed.relayOnce(100, { budgetMs: 450, now });
    expect(both.published).toBe(1);
    expect(both.truncated).toBe(true);
    expect(both.failure).toBeInstanceOf(Error);
    // Keep going: nothing is lost, nothing is duplicated except the event whose second send failed.
    for (let i = 0; i < 10 && (await pendingIds()).length > 0; i++) await relayWith().relayOnce();
    const risk = (await drain(riskUrl)).map(e => e.eventId as string);
    expect(new Set(risk)).toEqual(new Set(events.map(e => e.eventId)));
    await drain(notificationUrl);
  });

  it('TC-91-10 on shutdown the relay finishes the event in flight and starts no other', async () => {
    const events = Array.from({ length: 5 }, transferEvent);
    for (const event of events) await enqueue(event);
    const hold = gate();
    let entered!: () => void;
    const inside = new Promise<void>(resolve => (entered = resolve));
    let calls = 0;
    const relay = relayWith(async (url, body, attributes) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await hold.open;
      }
      return sqs.send(url, body, attributes);
    });
    const run = relay.relayOnce();
    await inside;
    const stopped = relay.onApplicationShutdown();
    hold.release();
    await stopped;
    expect(await run).toEqual({ published: 1 });
    expect(calls).toBe(2); // both queues of the first event, nothing for the others
    expect(await pendingIds()).toHaveLength(4);
    await drain(riskUrl);
    await drain(notificationUrl);
  });

  it('TC-91-13 a failed send is logged with the outbox id and without payload or error text', async () => {
    const event = transferEvent();
    await enqueue(event);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const relay = relayWith(() => Promise.reject(new Error('secret-detail-from-sqs')));
      await relay.relayOnce();
      expect(warn).toHaveBeenCalled();
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toMatch(/outboxId/);
      expect(logged).not.toContain('secret-detail-from-sqs');
      expect(logged).not.toContain(event.eventId);
      expect(logged).not.toContain(String(event.fromAccountId));
    } finally {
      warn.mockRestore();
    }
  });
});
