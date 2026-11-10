import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { PinoLogger } from 'nestjs-pino';
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
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

type Row = { user_id: string; kind: string; message: string };

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

  async function setup(): Promise<{ url: string; dlq: string; consumer: NotificationConsumer }> {
    const name = `dbs104-${randomUUID()}`;
    const make = async (n: string): Promise<string> => {
      const result = await admin.send(new CreateQueueCommand({ QueueName: n }));
      const url = new URL(new URL(result.QueueUrl!).pathname, mq.endpoint).toString();
      created.push(url);
      return url;
    };
    const url = await make(name);
    const dlq = await make(`${name}-dlq`);
    const consumer = new NotificationConsumer(
      tx,
      sqs,
      new PinoLogger({ pinoHttp: { level: 'silent' } } as never),
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
  const logRows = async (): Promise<Row[]> =>
    (await q(
      'SELECT user_id,kind,message FROM notification_log ORDER BY user_id,kind,message',
    )) as Row[];

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
    sqs?.onModuleDestroy();
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
    await drain(consumer, 3);
    expect((await logRows()).map(r => r.user_id).sort()).toEqual(
      [TRANSFER_SAMPLE.fromUserId, TRANSFER_SAMPLE.toUserId].sort(),
    );
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
  });

  it('TC-104-03 messages in either order raise no error and leave the same notification_log', async () => {
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
    };
    const results: Row[][] = [];
    for (const order of [
      [lock, unlock, older, newer],
      [newer, older, unlock, lock],
    ]) {
      await q('DELETE FROM notification_log');
      await q('DELETE FROM processed_events');
      const { url, consumer } = await setup();
      for (const event of order) await sqs.send(url, JSON.stringify(event));
      expect(await drain(consumer, 4)).toEqual([
        'acknowledged',
        'acknowledged',
        'acknowledged',
        'acknowledged',
      ]);
      results.push(await logRows());
    }
    expect(results[0]).toHaveLength(2 + 4); // lock, unlock, sender and recipient of two transfers
    expect(results[1]).toEqual(results[0]);
  });
});
