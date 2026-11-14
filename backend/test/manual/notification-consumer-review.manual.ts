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
import { drainStatuses, receiveBodies } from '../support/manual-wait';
import { createTempDatabase, migrate } from '../support/temp-database';

const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:9324';
process.env.AWS_ACCESS_KEY_ID = 'local';
process.env.AWS_SECRET_ACCESS_KEY = 'local';

/** M-104-04: no backoff, so the redelivery after the user is created does not wait 10 s. */
class NoBackoffNotification extends NotificationConsumer {
  protected override get retryBackoffSeconds(): number {
    return 0;
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
    const fresh = async (Consumer: typeof NotificationConsumer = NotificationConsumer) => {
      const name = `dbs104-manual-${randomUUID()}`;
      const url = await create(name);
      const dlq = await create(`${name}-dlq`);
      const consumer = new Consumer(
        tx,
        sqs,
        new PinoLogger({ pinoHttp: { level: 'silent' } } as never),
        { notificationQueueUrl: url } as never,
        new AuditService(tx),
      );
      return { url, dlq, consumer };
    };
    const drain = (consumer: NotificationConsumer, expected: number) =>
      drainStatuses(consumer, expected);
    // `event_id` is part of every comparison: an effect written under the wrong event must show.
    const rows = () =>
      q(
        'SELECT event_id,user_id,kind,message FROM notification_log ORDER BY event_id,user_id,kind,message',
      );
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
    assert.equal(mixed.length, 4);
    assert.equal(mixed.includes('failed'), false);
    assert.equal(mixed.filter(s => s === 'dead-lettered').length, 2);
    assert.equal(mixed.filter(s => s === 'acknowledged').length, 2);
    const opts = { waitTimeSeconds: 1, visibilityTimeout: 0 };
    assert.deepEqual(await sqs.receive(ctx.url, opts), []);
    // The DLQ is read until both bodies arrived (a receive may come back short), never just once.
    const dead = await receiveBodies(sqs, ctx.dlq, 2);
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
      // One event at a time: the order of processing is the order of the array. (A batch received
      // at once is handled concurrently, which says nothing about order.)
      for (const e of order) {
        await sqs.send(ctx.url, JSON.stringify(e));
        assert.deepEqual(await drain(ctx.consumer, 1), ['acknowledged']);
      }
      const written = (await q('SELECT event_id FROM notification_log ORDER BY id')).map(
        r => r.event_id,
      );
      assert.deepEqual(
        [...new Set(written)],
        order.map(e => e.eventId),
        'rows were written in the order the events were handled',
      );
      results.push(JSON.stringify(await rows()));
    }
    assert.equal(results[0], results[1]);
    assert.equal((JSON.parse(results[0]) as unknown[]).length, 6);
    console.log(
      'M-104-03 PASS: handled one at a time, forward and reversed -> identical notification_log (6 rows, event_id compared)',
    );

    // M-104-04 (BL-212): the recovery path. A transfer to a user who does not exist yet comes back
    // `failed` and writes nothing; once the user exists the same message is applied exactly once.
    await reset();
    const quick = await fresh(NoBackoffNotification);
    const late = { ...TRANSFER_SAMPLE, eventId: randomUUID(), toUserId: randomUUID() };
    await sqs.send(quick.url, JSON.stringify(late));
    assert.deepEqual(await drain(quick.consumer, 1), ['failed']);
    assert.equal((await rows()).length, 0);
    assert.equal((await q('SELECT 1 FROM processed_events')).length, 0);
    await q('INSERT INTO users(id,cognito_sub) VALUES($1,$2)', [late.toUserId, randomUUID()]);
    assert.deepEqual(await drain(quick.consumer, 1), ['acknowledged']);
    assert.equal((await rows()).length, 2);
    assert.equal((await q('SELECT 1 FROM processed_events')).length, 1);
    assert.deepEqual(
      await sqs.receive(quick.url, { waitTimeSeconds: 1, visibilityTimeout: 0 }),
      [],
    );
    assert.deepEqual(
      await sqs.receive(quick.dlq, { waitTimeSeconds: 1, visibilityTimeout: 0 }),
      [],
    );
    console.log(
      'M-104-04 PASS: missing recipient -> failed, nothing written; user created -> acknowledged, 2 rows, 1 processed_events, DLQ empty',
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
