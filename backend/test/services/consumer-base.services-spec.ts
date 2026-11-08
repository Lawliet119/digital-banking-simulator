import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { PinoLogger } from 'nestjs-pino';
import { DataSource, type EntityManager } from 'typeorm';
import type { DomainEvent } from '@common/events';
import { ConsumerBase, MAX_ATTEMPTS } from '@common/messaging';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import {
  localSqsClient,
  startElasticMqContainer,
  type StartedElasticMq,
} from '../support/elasticmq.container';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/** DBS-101: the frame against a real SQS protocol server (ElasticMQ) and real PostgreSQL. */
describe('ConsumerBase (real PostgreSQL + ElasticMQ)', () => {
  class QueueConsumer extends ConsumerBase {
    alwaysFail = false;
    backoff = 0;
    constructor(
      protected readonly consumerName: string,
      private readonly url: string,
      tx: TransactionService,
      sqs: SqsClient,
    ) {
      super(tx, sqs, new PinoLogger({ pinoHttp: { level: 'silent' } } as never));
    }
    protected override get retryBackoffSeconds(): number {
      return this.backoff;
    }
    protected queueUrl(): string {
      return this.url;
    }
    protected async apply(event: DomainEvent, manager: EntityManager): Promise<void> {
      if (this.alwaysFail) throw new Error('downstream is unavailable');
      await manager.query(
        `INSERT INTO notification_log(event_id,kind,user_id,message) VALUES($1,'transfer_completed',NULL,$2)`,
        [event.eventId, this.consumerName],
      );
    }
  }

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
  const event = () => ({ ...TRANSFER_SAMPLE, eventId: randomUUID() });
  const opts = { waitTimeSeconds: 1, visibilityTimeout: 0 };

  /** A queue and its `-dlq` twin, as `dlqUrlFor` names them. */
  async function queuePair(): Promise<{ url: string; dlq: string }> {
    const name = `dbs101-${randomUUID()}`;
    const make = async (n: string): Promise<string> => {
      const result = await admin.send(new CreateQueueCommand({ QueueName: n }));
      const url = new URL(new URL(result.QueueUrl!).pathname, mq.endpoint).toString();
      created.push(url);
      return url;
    };
    const url = await make(name);
    const dlq = await make(`${name}-dlq`);
    return { url, dlq };
  }
  const effects = async (consumerName: string) =>
    (
      (
        await q(`SELECT count(*)::int n FROM notification_log WHERE message=$1`, [consumerName])
      )[0] as {
        n: number;
      }
    ).n;

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    mq = await startElasticMqContainer();
    admin = localSqsClient(mq.endpoint);
    sqs = new SqsClient({ region: 'us-east-1', endpoint: mq.endpoint });
    db = await createTempDatabase();
    await migrate(db.url);
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

  it('TC-101-07 a message that breaks the schema reaches the DLQ at the first receive and the next message is still processed', async () => {
    const { url, dlq } = await queuePair();
    const consumer = new QueueConsumer('c07', url, tx, sqs);
    const good = event();
    await sqs.send(url, '{"eventType":"TransferCompleted"}');
    await sqs.send(url, JSON.stringify(good));
    const statuses: string[] = [];
    for (let i = 0; i < 5 && statuses.length < 2; i++) {
      for (const r of await consumer.consumeOnce(1, 0)) statuses.push(r.status);
    }
    expect(statuses.sort()).toEqual(['acknowledged', 'dead-lettered']);
    expect(await sqs.receive(url, opts)).toEqual([]);
    const [poison] = await sqs.receive(dlq, opts);
    expect(JSON.parse(poison.Body!)).toEqual({ eventType: 'TransferCompleted' });
    expect(await effects('c07')).toBe(1);
  });

  it('TC-101-08 a transient failure is retried and the message is dead-lettered on the fifth receive', async () => {
    const { url, dlq } = await queuePair();
    const consumer = new QueueConsumer('c08', url, tx, sqs);
    consumer.alwaysFail = true;
    const e = event();
    await sqs.send(url, JSON.stringify(e));
    const statuses: string[] = [];
    for (let i = 0; i < 12 && !statuses.includes('dead-lettered'); i++) {
      for (const r of await consumer.consumeOnce(1, 0)) statuses.push(r.status);
    }
    expect(statuses).toEqual([...Array<string>(MAX_ATTEMPTS - 1).fill('failed'), 'dead-lettered']);
    expect(await sqs.receive(url, opts)).toEqual([]);
    const [dead] = await sqs.receive(dlq, opts);
    expect((JSON.parse(dead.Body!) as DomainEvent).eventId).toBe(e.eventId);
    const claims = await q(`SELECT 1 FROM processed_events WHERE consumer='c08'`);
    expect(claims).toHaveLength(0);
  });

  it('TC-101-09 a failing consumer does not touch the messages of another consumer', async () => {
    const a = await queuePair();
    const b = await queuePair();
    const broken = new QueueConsumer('c09a', a.url, tx, sqs);
    broken.alwaysFail = true;
    const healthy = new QueueConsumer('c09b', b.url, tx, sqs);
    for (let i = 0; i < 2; i++) {
      await sqs.send(a.url, JSON.stringify(event()));
      await sqs.send(b.url, JSON.stringify(event()));
    }
    for (let i = 0; i < 12; i++) {
      await broken.consumeOnce(1, 0);
      await healthy.consumeOnce(1, 0);
    }
    expect(await effects('c09b')).toBe(2);
    expect(await effects('c09a')).toBe(0);
    expect(await sqs.receive(b.dlq, opts)).toEqual([]);
    expect(await sqs.receive(a.dlq, { ...opts, maxMessages: 10 })).toHaveLength(2);
  });
  it('TC-102-03 a failed message stays hidden for the backoff, then comes back', async () => {
    const { url } = await queuePair();
    const consumer = new QueueConsumer('c102', url, tx, sqs);
    consumer.alwaysFail = true;
    consumer.backoff = 2;
    await sqs.send(url, JSON.stringify(event()));
    const [first] = await consumer.consumeOnce(1);
    expect(first.status).toBe('failed');
    // Without the backoff the default 30 s timeout would apply; with it the message is back in ~2 s.
    expect(await sqs.receive(url, { waitTimeSeconds: 0, visibilityTimeout: 0 })).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 2500));
    const [again] = await consumer.consumeOnce(1);
    expect(again.messageId).toBe(first.messageId);
  });
});
