// From backend/: DATABASE_URL=<postgres server> npx ts-node -r tsconfig-paths/register test/manual/notification-consumer-review.manual.ts
// Needs `docker compose up -d` (ElasticMQ on :9324) and a PostgreSQL server for the throwaway DB.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
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
import { createTempDatabase, migrate } from '../support/temp-database';

const endpoint = 'http://localhost:9324';
process.env.AWS_ACCESS_KEY_ID = 'local';
process.env.AWS_SECRET_ACCESS_KEY = 'local';

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
    for (const id of [
      TRANSFER_SAMPLE.fromUserId,
      TRANSFER_SAMPLE.toUserId,
      DEPOSIT_SAMPLE.toUserId,
      ACCOUNT_LOCKED_SAMPLE.ownerUserId,
    ])
      await q('INSERT INTO users(id,cognito_sub) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        id,
        randomUUID(),
      ]);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    const tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    const fresh = async () => {
      const name = `dbs104-manual-${randomUUID()}`;
      const url = await create(name);
      const dlq = await create(`${name}-dlq`);
      const consumer = new NotificationConsumer(
        tx,
        sqs,
        new PinoLogger({ pinoHttp: { level: 'silent' } } as never),
        { notificationQueueUrl: url } as never,
        new AuditService(tx),
      );
      return { url, dlq, consumer };
    };
    const drain = async (consumer: NotificationConsumer, expected: number) => {
      const statuses: string[] = [];
      for (let i = 0; i < 12 && statuses.length < expected; i++)
        for (const r of await consumer.consumeOnce(1, 0)) statuses.push(r.status);
      return statuses;
    };
    const rows = () =>
      q('SELECT user_id,kind,message FROM notification_log ORDER BY user_id,kind,message');
    const reset = async () => {
      await q('DELETE FROM notification_log');
      await q('DELETE FROM processed_events');
    };

    // M-104-01: the same eventId three times.
    let ctx = await fresh();
    const lock = { ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID() };
    for (let i = 0; i < 3; i++) await sqs.send(ctx.url, JSON.stringify(lock));
    const dup = await drain(ctx.consumer, 3);
    assert.deepEqual(dup, ['acknowledged', 'acknowledged', 'acknowledged']);
    assert.equal((await rows()).length, 1);
    console.log(`M-104-01 PASS: eventId x3 -> ${dup.join(',')}; notification_log rows = 1`);

    // M-104-02: broken messages between good ones.
    await reset();
    ctx = await fresh();
    const broken = ['not json at all {', JSON.stringify({ eventType: 'TransferCompleted' })];
    const deposit = { ...DEPOSIT_SAMPLE, eventId: randomUUID() };
    await sqs.send(ctx.url, broken[0]);
    await sqs.send(ctx.url, JSON.stringify(deposit));
    await sqs.send(ctx.url, broken[1]);
    await sqs.send(ctx.url, JSON.stringify({ ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID() }));
    const mixed = await drain(ctx.consumer, 4);
    assert.equal(mixed.filter(s => s === 'dead-lettered').length, 2);
    assert.equal(mixed.filter(s => s === 'acknowledged').length, 2);
    const opts = { waitTimeSeconds: 1, visibilityTimeout: 0 };
    assert.deepEqual(await sqs.receive(ctx.url, opts), []);
    const dead = (await sqs.receive(ctx.dlq, { ...opts, maxMessages: 10 })).map(m => m.Body);
    assert.deepEqual(new Set(dead), new Set(broken));
    assert.equal((await rows()).length, 2);
    console.log(
      `M-104-02 PASS: ${mixed.join(',')}; DLQ holds both broken bodies after one receive; 2 good events processed`,
    );

    // M-104-03: reversed order gives the same table.
    const events = [
      { ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID() },
      { ...ACCOUNT_ACTIVE_SAMPLE, eventId: randomUUID() },
      { ...TRANSFER_SAMPLE, eventId: randomUUID(), occurredAt: '2026-10-19T03:00:00.000Z' },
      { ...TRANSFER_SAMPLE, eventId: randomUUID(), occurredAt: '2026-10-19T03:10:00.000Z' },
    ];
    const results: string[] = [];
    for (const order of [events, [...events].reverse()]) {
      await reset();
      ctx = await fresh();
      for (const e of order) await sqs.send(ctx.url, JSON.stringify(e));
      const statuses = await drain(ctx.consumer, 4);
      assert.equal(
        statuses.every(s => s === 'acknowledged'),
        true,
      );
      results.push(JSON.stringify(await rows()));
    }
    assert.equal(results[0], results[1]);
    console.log(
      'M-104-03 PASS: forward and reversed order -> no error, identical notification_log (6 rows)',
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
