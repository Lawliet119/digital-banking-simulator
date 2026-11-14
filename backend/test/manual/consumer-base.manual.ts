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
import { drainStatuses, receiveBodies, until } from '../support/manual-wait';
import { createTempDatabase, migrate } from '../support/temp-database';

const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:9324';
process.env.AWS_ACCESS_KEY_ID = 'local';
process.env.AWS_SECRET_ACCESS_KEY = 'local';

class DemoConsumer extends ConsumerBase {
  failing = false;
  /** Seconds a failed message stays hidden; 0 for M-101-03 (the fifth receive), 2 for M-101-04. */
  backoff = 0;
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
  // The default backoff (5/10/20/40 s, DBS-102) would hide the message for longer than M-101-03
  // waits; that step is about the fifth receive, not about the delay, so it turns the backoff off.
  // M-101-04 turns a short one on to show the delay and the recovery.
  protected override get retryBackoffSeconds(): number {
    return this.backoff;
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
    const first3 = await drainStatuses(consumer, 3);
    const acked = first3.filter(status => status === 'acknowledged').length;
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
    assert.deepEqual(await drainStatuses(consumer, 1), ['dead-lettered']);
    assert.deepEqual(await sqs.receive(url, opts), []);
    // The DLQ is read until the message shows up (a receive may come back short), never just once.
    const [bad] = await receiveBodies(sqs, dlq, 1);
    assert.deepEqual(JSON.parse(bad), { eventType: 'TransferCompleted' });
    console.log('M-101-02 PASS: schema-breaking message -> DLQ at the first receive, source empty');

    consumer.failing = true;
    const e3 = { ...TRANSFER_SAMPLE, eventId: randomUUID() };
    await sqs.send(url, JSON.stringify(e3));
    const statuses: string[] = [];
    await until(async () => {
      for (const r of await consumer.consumeOnce(1, 0)) statuses.push(r.status);
      return statuses.includes('dead-lettered');
    }, 'the fifth receive to dead-letter the message');
    assert.deepEqual(statuses, ['failed', 'failed', 'failed', 'failed', 'dead-lettered']);
    const [dead] = await receiveBodies(sqs, dlq, 1);
    assert.equal((JSON.parse(dead) as DomainEvent).eventId, e3.eventId);
    const marks = await q(`SELECT 1 FROM processed_events WHERE event_id=$1`, [e3.eventId]);
    assert.equal(marks.length, 0);
    console.log(
      `M-101-03 PASS: failing apply -> ${statuses.join(',')}; DLQ holds the event; no processed_events row`,
    );

    // M-101-04 (BL-212): the recovery path. A failure with a 2 s backoff hides the message; the
    // downstream comes back; the redelivery applies the event exactly once.
    consumer.backoff = 2;
    consumer.failing = true;
    const e4 = { ...TRANSFER_SAMPLE, eventId: randomUUID() };
    await sqs.send(url, JSON.stringify(e4));
    assert.deepEqual(await drainStatuses(consumer, 1), ['failed']);
    assert.deepEqual(await sqs.receive(url, { waitTimeSeconds: 0, visibilityTimeout: 0 }), []);
    assert.equal(
      (await q(`SELECT 1 FROM processed_events WHERE event_id=$1`, [e4.eventId])).length,
      0,
    );
    consumer.failing = false;
    const hiddenSince = Date.now();
    assert.deepEqual(await drainStatuses(consumer, 1, 20_000), ['acknowledged']);
    const waited = Date.now() - hiddenSince;
    assert.ok(waited >= 1000, `the backoff held the message for ${waited} ms`);
    const after = await q(
      `SELECT (SELECT count(*)::int FROM processed_events WHERE event_id=$1) AS claims,
              (SELECT count(*)::int FROM notification_log WHERE event_id=$1) AS effects`,
      [e4.eventId],
    );
    assert.deepEqual(after, [{ claims: 1, effects: 1 }]);
    assert.deepEqual(await sqs.receive(dlq, opts), []);
    console.log(
      `M-101-04 PASS: failed, hidden ${waited} ms by the backoff, downstream back -> acknowledged; claims=1, effects=1, DLQ empty`,
    );
  } finally {
    for (const url of queues)
      await sdk.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
    await source?.destroy();
    await db.drop();
    sqs.onApplicationShutdown();
    sdk.destroy();
    console.log('cleanup done: temp database dropped, temp queues deleted');
  }
}

main().catch((error: unknown) => {
  console.error('FAILED', error);
  process.exitCode = 1;
});
