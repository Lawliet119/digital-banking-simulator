import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { installSilentRootLogger } from '../support/silent-root-logger';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import { NotificationConsumer } from '@modules/notification';
import { AuditService } from '@modules/audit';
import {
  ACCOUNT_ACTIVE_SAMPLE,
  ACCOUNT_LOCKED_SAMPLE,
  DEPOSIT_SAMPLE,
  TRANSFER_SAMPLE,
} from '../support/event-samples';
import {
  localSqsClient,
  startElasticMqContainer,
  type StartedElasticMq,
} from '../support/elasticmq.container';
import { buildRiskConsumer } from '../support/risk-consumer';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

installSilentRootLogger();

type Row = { event_id: string; user_id: string; kind: string; message: string };

/** No backoff, so TC-102-07 can take the five receives of a failing message one after another. */
class NoBackoffNotification extends NotificationConsumer {
  protected override get retryBackoffSeconds(): number {
    return 0;
  }
}

/**
 * DBS-104, Review Focus 4: the notification consumer when a message is a duplicate, broken or out of
 * order, through a real SQS protocol server (ElasticMQ) and real PostgreSQL.
 */
describe('notification consumer review focus (real PostgreSQL + ElasticMQ)', () => {
  let mq: StartedElasticMq;
  let admin: ReturnType<typeof localSqsClient>;
  let db: TempDatabase;
  let source: DataSource;
  let sqs: SqsClient;
  let tx: TransactionService;
  const created: string[] = [];
  const oldKey = process.env.AWS_ACCESS_KEY_ID;
  const oldSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;
  const opts = { waitTimeSeconds: 1, visibilityTimeout: 0 };

  async function queuePair(): Promise<{ url: string; dlq: string }> {
    const name = `dbs104-${randomUUID()}`;
    const make = async (n: string): Promise<string> => {
      const result = await admin.send(new CreateQueueCommand({ QueueName: n }));
      const url = new URL(new URL(result.QueueUrl!).pathname, mq.endpoint).toString();
      created.push(url);
      return url;
    };
    return { url: await make(name), dlq: await make(`${name}-dlq`) };
  }
  async function setup(
    Consumer: typeof NotificationConsumer = NotificationConsumer,
  ): Promise<{ url: string; dlq: string; consumer: NotificationConsumer }> {
    const { url, dlq } = await queuePair();
    const consumer = new Consumer(
      tx,
      sqs,
      { notificationQueueUrl: url } as never,
      new AuditService(tx),
    );
    return { url, dlq, consumer };
  }
  /** Receives until `expected` results arrived (SQS may return short batches). */
  async function drain(consumer: NotificationConsumer, expected: number): Promise<string[]> {
    const statuses: string[] = [];
    for (let i = 0; i < 12 && statuses.length < expected; i++) {
      for (const r of await consumer.consumeOnce(1, 0)) statuses.push(r.status);
    }
    return statuses;
  }
  /** Includes `event_id`, so an effect written under the wrong event cannot look the same. */
  const logRows = async (): Promise<Row[]> =>
    (await q(
      'SELECT event_id,user_id,kind,message FROM notification_log ORDER BY event_id,user_id,kind,message',
    )) as Row[];
  /** The order the rows were really written in (`id` is an identity column). */
  const processingOrder = async (): Promise<string[]> => {
    const rows = (await q('SELECT event_id FROM notification_log ORDER BY id')) as {
      event_id: string;
    }[];
    return [...new Set(rows.map(r => r.event_id))];
  };

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    mq = await startElasticMqContainer();
    admin = localSqsClient(mq.endpoint);
    sqs = new SqsClient({ region: 'us-east-1', endpoint: mq.endpoint });
    db = await createTempDatabase();
    await migrate(db.url);
    for (const id of [
      TRANSFER_SAMPLE.fromUserId,
      TRANSFER_SAMPLE.toUserId,
      DEPOSIT_SAMPLE.toUserId,
      ACCOUNT_LOCKED_SAMPLE.ownerUserId,
    ]) {
      await q('INSERT INTO users(id,cognito_sub) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        id,
        randomUUID(),
      ]);
    }
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
  });
  afterAll(async () => {
    for (const url of created) await admin.send(new DeleteQueueCommand({ QueueUrl: url }));
    sqs?.onApplicationShutdown();
    admin?.destroy();
    await source?.destroy();
    await db?.drop();
    await mq?.stop();
    if (oldKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = oldKey;
    if (oldSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = oldSecret;
  });
  beforeEach(async () => {
    await q('DELETE FROM notification_log');
    await q('DELETE FROM processed_events');
  });

  it('TC-104-01 the same eventId sent three times leaves exactly one notification_log row', async () => {
    const { url, consumer } = await setup();
    const event = { ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID() };
    for (let i = 0; i < 3; i++) await sqs.send(url, JSON.stringify(event));
    expect(await drain(consumer, 3)).toEqual(['acknowledged', 'acknowledged', 'acknowledged']);
    expect(await logRows()).toHaveLength(1);
    expect(await q('SELECT 1 FROM processed_events')).toHaveLength(1);
    expect(await sqs.receive(url, opts)).toEqual([]);
  });

  it('TC-104-01 a transfer sent three times leaves one row per recipient, not three', async () => {
    const { url, consumer } = await setup();
    const event = { ...TRANSFER_SAMPLE, eventId: randomUUID() };
    for (let i = 0; i < 3; i++) await sqs.send(url, JSON.stringify(event));
    expect(await drain(consumer, 3)).toEqual(['acknowledged', 'acknowledged', 'acknowledged']);
    expect((await logRows()).map(r => r.user_id).sort()).toEqual(
      [TRANSFER_SAMPLE.fromUserId, TRANSFER_SAMPLE.toUserId].sort(),
    );
    expect(await q('SELECT 1 FROM processed_events')).toHaveLength(1);
    expect(await sqs.receive(url, opts)).toEqual([]);
  });

  it('TC-104-02 broken messages go to the DLQ at the first receive and the messages after them are processed', async () => {
    const { url, dlq, consumer } = await setup();
    const good = [
      { ...DEPOSIT_SAMPLE, eventId: randomUUID() },
      { ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID() },
    ];
    const broken = [
      'not json at all {',
      JSON.stringify({ eventType: 'TransferCompleted' }),
      JSON.stringify({ ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID(), newStatus: 'DELETED' }),
      JSON.stringify({ ...TRANSFER_SAMPLE, eventId: randomUUID(), amount: 500000 }),
    ];
    await sqs.send(url, broken[0]);
    await sqs.send(url, JSON.stringify(good[0]));
    await sqs.send(url, broken[1]);
    await sqs.send(url, broken[2]);
    await sqs.send(url, JSON.stringify(good[1]));
    await sqs.send(url, broken[3]);

    const statuses = await drain(consumer, 6);
    // Exactly one result per message: a broken message that was received twice, or failed once
    // before it was dead-lettered, would add a result, and `failed` would show up here.
    expect(statuses).toHaveLength(6);
    expect(statuses).not.toContain('failed');
    expect(statuses.filter(s => s === 'dead-lettered')).toHaveLength(4);
    expect(statuses.filter(s => s === 'acknowledged')).toHaveLength(2);
    expect(await sqs.receive(url, opts)).toEqual([]);

    const dead: string[] = [];
    for (let i = 0; i < 6 && dead.length < 4; i++) {
      for (const m of await sqs.receive(dlq, { ...opts, maxMessages: 10 })) dead.push(m.Body!);
    }
    expect(new Set(dead)).toEqual(new Set(broken));
    expect((await logRows()).map(r => r.user_id).sort()).toEqual(
      [DEPOSIT_SAMPLE.toUserId, ACCOUNT_LOCKED_SAMPLE.ownerUserId].sort(),
    );
    expect(await q('SELECT 1 FROM processed_events')).toHaveLength(2); // the two valid events only
  });

  /**
   * Events are sent and handled one at a time, so the order of processing is the order of the
   * array (a batch received at once is handled concurrently and would prove nothing about order).
   */
  async function runInOrder(events: { eventId: string }[]): Promise<void> {
    await q('DELETE FROM notification_log');
    await q('DELETE FROM processed_events');
    const { url, dlq, consumer } = await setup();
    for (const event of events) {
      await sqs.send(url, JSON.stringify(event));
      const results = await consumer.consumeOnce(1, 0);
      expect(results.map(r => r.status)).toEqual(['acknowledged']);
    }
    expect(await sqs.receive(url, opts)).toEqual([]);
    expect(await sqs.receive(dlq, opts)).toEqual([]);
    // The rows were written in the order of the array: the test really controlled the order.
    expect(await processingOrder()).toEqual(events.map(e => e.eventId));
  }

  it('TC-104-03 events handled one at a time in opposite orders leave the same rows, each under its own event_id', async () => {
    const lock = { ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID() };
    const unlock = { ...ACCOUNT_ACTIVE_SAMPLE, eventId: randomUUID() };
    const older = {
      ...TRANSFER_SAMPLE,
      eventId: randomUUID(),
      occurredAt: '2026-10-19T03:00:00.000Z',
    };
    const newer = {
      ...TRANSFER_SAMPLE,
      eventId: randomUUID(),
      occurredAt: '2026-10-19T03:10:00.000Z',
      amount: '700000', // the only difference: not in any notice text, so only event_id tells them apart
    };
    const events = [lock, unlock, older, newer];
    const expected = (): Row[] => {
      const rows: Row[] = [
        {
          event_id: lock.eventId,
          user_id: ACCOUNT_LOCKED_SAMPLE.ownerUserId,
          kind: 'account_status_changed',
          message: 'Tài khoản của bạn đã bị tạm khóa. Vui lòng liên hệ ngân hàng để được hỗ trợ',
        },
        {
          event_id: unlock.eventId,
          user_id: ACCOUNT_LOCKED_SAMPLE.ownerUserId,
          kind: 'account_status_changed',
          message: 'Tài khoản của bạn đã được mở khóa',
        },
      ];
      for (const transfer of [older, newer]) {
        rows.push(
          {
            event_id: transfer.eventId,
            user_id: TRANSFER_SAMPLE.fromUserId as string,
            kind: 'transfer_completed',
            message: 'Bạn đã chuyển tiền thành công',
          },
          {
            event_id: transfer.eventId,
            user_id: TRANSFER_SAMPLE.toUserId,
            kind: 'transfer_completed',
            message: 'Tài khoản của bạn vừa nhận tiền',
          },
        );
      }
      return rows;
    };
    const results: Row[][] = [];
    for (const order of [events, [...events].reverse()]) {
      await runInOrder(order);
      const rows = await logRows();
      // Sorted by the database collation, so compare as sets of rows.
      expect(rows).toHaveLength(6);
      expect(new Set(rows.map(r => JSON.stringify(r)))).toEqual(
        new Set(expected().map(r => JSON.stringify(r))),
      );
      results.push(rows);
    }
    expect(new Set(results[1].map(r => JSON.stringify(r)))).toEqual(
      new Set(results[0].map(r => JSON.stringify(r))),
    );
  });

  it('TC-104-03 a batch received at once (handled concurrently) also leaves the same rows, event_id included', async () => {
    const events = [
      { ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID() },
      { ...ACCOUNT_ACTIVE_SAMPLE, eventId: randomUUID() },
      { ...TRANSFER_SAMPLE, eventId: randomUUID() },
      { ...TRANSFER_SAMPLE, eventId: randomUUID() },
    ];
    const results: Row[][] = [];
    for (const order of [events, [...events].reverse()]) {
      await q('DELETE FROM notification_log');
      await q('DELETE FROM processed_events');
      const { url, consumer } = await setup();
      for (const event of order) await sqs.send(url, JSON.stringify(event));
      expect(await drain(consumer, 4)).toEqual(Array(4).fill('acknowledged'));
      results.push(await logRows());
    }
    expect(results[0]).toHaveLength(2 + 4); // lock, unlock, sender and recipient of two transfers
    expect(new Set(results[0].map(r => r.event_id))).toEqual(new Set(events.map(e => e.eventId)));
    expect(results[1]).toEqual(results[0]);
  });

  it('TC-102-07 a notification that keeps failing (recipient is no user) is dead-lettered on receive 5 and does not hold up a healthy risk-events queue', async () => {
    const notification = await setup(NoBackoffNotification);
    const riskQueue = await queuePair();
    const risk = buildRiskConsumer(source, { sqs, queueUrl: riskQueue.url }).consumer;
    const bad = { ...TRANSFER_SAMPLE, eventId: randomUUID(), toUserId: randomUUID() };
    const good = { ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID() };
    const deposit = { ...DEPOSIT_SAMPLE, eventId: randomUUID() }; // risk claims a deposit, never scores it
    await sqs.send(notification.url, JSON.stringify(bad));
    await sqs.send(notification.url, JSON.stringify(good));
    await sqs.send(riskQueue.url, JSON.stringify(deposit));

    const badStatuses: string[] = [];
    let healthyRiskResults: string[] = [];
    for (let receive = 1; receive <= 5; receive++) {
      const results = await notification.consumer.consumeOnce(1, 0);
      if (receive === 1) {
        expect(results.map(r => r.status).sort()).toEqual(['acknowledged', 'failed']);
        // The risk queue is polled while the notification message is still failing.
        healthyRiskResults = (await risk.consumeOnce(1, 0)).map(r => r.status);
      } else {
        expect(results).toHaveLength(1);
      }
      badStatuses.push(results.find(r => r.status !== 'acknowledged')!.status);
    }
    expect(badStatuses).toEqual(['failed', 'failed', 'failed', 'failed', 'dead-lettered']);
    expect(healthyRiskResults).toEqual(['acknowledged']);

    // Nothing of the failing event survived any of the five transactions...
    expect(await q('SELECT 1 FROM notification_log WHERE event_id = $1', [bad.eventId])).toEqual(
      [],
    );
    expect(await q('SELECT 1 FROM processed_events WHERE event_id = $1', [bad.eventId])).toEqual(
      [],
    );
    // ...the message is in the DLQ once, the source queue is empty...
    expect(await sqs.receive(notification.url, opts)).toEqual([]);
    const dead = await sqs.receive(notification.dlq, { ...opts, maxMessages: 10 });
    expect(dead.map(m => (JSON.parse(m.Body!) as { eventId: string }).eventId)).toEqual([
      bad.eventId,
    ]);
    // ...the healthy event of the same queue was applied, and the risk queue neither failed nor dead-lettered.
    expect((await logRows()).map(r => r.event_id)).toEqual([good.eventId]);
    expect(
      await q(`SELECT consumer FROM processed_events WHERE event_id = $1`, [deposit.eventId]),
    ).toEqual([{ consumer: 'risk' }]);
    expect(await sqs.receive(riskQueue.url, opts)).toEqual([]);
    expect(await sqs.receive(riskQueue.dlq, opts)).toEqual([]);
  });
});
