// From backend/: DATABASE_URL=<postgres server> npx ts-node -r tsconfig-paths/register test/manual/consumer-base.manual.ts
// Needs `docker compose up -d` (ElasticMQ on :9324) and a PostgreSQL server for the throwaway DB.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { PinoLogger } from 'nestjs-pino';
import { DataSource, type EntityManager } from 'typeorm';
import type { DomainEvent } from '@common/events';
import { ConsumerBase } from '@common/messaging';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import { createTempDatabase, migrate } from '../support/temp-database';

const endpoint = 'http://localhost:9324';
process.env.AWS_ACCESS_KEY_ID = 'local';
process.env.AWS_SECRET_ACCESS_KEY = 'local';

class DemoConsumer extends ConsumerBase {
  failing = false;
  protected readonly consumerName = 'dbs101-manual';
  constructor(
    private readonly url: string,
    tx: TransactionService,
    sqs: SqsClient,
  ) {
    super(tx, sqs, new PinoLogger({ pinoHttp: { level: 'silent' } } as never));
  }
  protected queueUrl(): string {
    return this.url;
  }
  protected async apply(event: DomainEvent, manager: EntityManager): Promise<void> {
    if (this.failing) throw new Error('downstream unavailable');
    await manager.query(
      `INSERT INTO notification_log(event_id,kind,user_id,message) VALUES($1,'transfer_completed',NULL,'manual')`,
      [event.eventId],
    );
  }
}

async function main(): Promise<void> {
  const sdk = new SQSClient({ endpoint, region: 'us-east-1' });
  const sqs = new SqsClient({ region: 'us-east-1', endpoint });
  const db = await createTempDatabase();
  const queues: string[] = [];
  let source: DataSource | undefined;
  const create = async (name: string): Promise<string> => {
    const r = await sdk.send(new CreateQueueCommand({ QueueName: name }));
    const url = new URL(new URL(r.QueueUrl!).pathname, endpoint).toString();
    queues.push(url);
    return url;
  };
  const q = (sql: string, args: unknown[] = []) =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;
  try {
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    const tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    const name = `dbs101-manual-${randomUUID()}`;
    const url = await create(name);
    const dlq = await create(`${name}-dlq`);
    const consumer = new DemoConsumer(url, tx, sqs);
    const opts = { waitTimeSeconds: 1, visibilityTimeout: 0 };

    const e1 = { ...TRANSFER_SAMPLE, eventId: randomUUID() };
    for (let i = 0; i < 3; i++) await sqs.send(url, JSON.stringify(e1));
    let acked = 0;
    for (let i = 0; i < 6 && acked < 3; i++)
      for (const r of await consumer.consumeOnce(1, 0)) if (r.status === 'acknowledged') acked++;
    const claims = await q(`SELECT count(*)::int n FROM processed_events WHERE event_id=$1`, [
      e1.eventId,
    ]);
    const logs = await q(`SELECT count(*)::int n FROM notification_log WHERE event_id=$1`, [
      e1.eventId,
    ]);
    assert.equal(acked, 3);
    assert.equal(Number(claims[0].n), 1);
    assert.equal(Number(logs[0].n), 1);
    console.log(
      `M-101-01 PASS: same eventId x3 -> ${acked} acknowledged, processed_events=1, effects=1`,
    );

    await sqs.send(url, JSON.stringify({ eventType: 'TransferCompleted' }));
    let first: string | undefined;
    for (let i = 0; i < 3 && !first; i++) first = (await consumer.consumeOnce(1, 0))[0]?.status;
    assert.equal(first, 'dead-lettered');
    assert.deepEqual(await sqs.receive(url, opts), []);
    const [bad] = await sqs.receive(dlq, opts);
    assert.deepEqual(JSON.parse(bad.Body!), { eventType: 'TransferCompleted' });
    await sqs.acknowledge(dlq, bad);
    console.log('M-101-02 PASS: schema-breaking message -> DLQ at the first receive, source empty');

    consumer.failing = true;
    const e3 = { ...TRANSFER_SAMPLE, eventId: randomUUID() };
    await sqs.send(url, JSON.stringify(e3));
    const statuses: string[] = [];
    for (let i = 0; i < 12 && !statuses.includes('dead-lettered'); i++)
      for (const r of await consumer.consumeOnce(1, 0)) statuses.push(r.status);
    assert.deepEqual(statuses, ['failed', 'failed', 'failed', 'failed', 'dead-lettered']);
    const [dead] = await sqs.receive(dlq, opts);
    assert.equal((JSON.parse(dead.Body!) as DomainEvent).eventId, e3.eventId);
    const marks = await q(`SELECT 1 FROM processed_events WHERE event_id=$1`, [e3.eventId]);
    assert.equal(marks.length, 0);
    console.log(
      `M-101-03 PASS: failing apply -> ${statuses.join(',')}; DLQ holds the event; no processed_events row`,
    );
  } finally {
    for (const url of queues)
      await sdk.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
    await source?.destroy();
    await db.drop();
    sqs.onModuleDestroy();
    sdk.destroy();
    console.log('cleanup done: temp database dropped, temp queues deleted');
  }
}

main().catch((error: unknown) => {
  console.error('FAILED', error);
  process.exitCode = 1;
});
