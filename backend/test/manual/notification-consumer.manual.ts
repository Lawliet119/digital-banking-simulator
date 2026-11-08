// From backend/: DATABASE_URL=<postgres server> npx ts-node -r tsconfig-paths/register test/manual/notification-consumer.manual.ts
// Needs `docker compose up -d` (ElasticMQ on :9324) and a PostgreSQL server for the throwaway DB.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { PinoLogger } from 'nestjs-pino';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import { NotificationConsumer } from '@modules/notification';
import { ACCOUNT_LOCKED_SAMPLE, TRANSFER_SAMPLE } from '../support/event-samples';
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
      ACCOUNT_LOCKED_SAMPLE.ownerUserId,
    ])
      await q('INSERT INTO users(id,cognito_sub) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        id,
        randomUUID(),
      ]);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    const name = `dbs102-manual-${randomUUID()}`;
    const url = await create(name);
    await create(`${name}-dlq`);
    const consumer = new NotificationConsumer(
      new TransactionService(source, {
        lockTimeoutMs: 2000,
        statementTimeoutMs: 5000,
        idleInTransactionTimeoutMs: 10000,
      } as never),
      sqs,
      new PinoLogger({ pinoHttp: { level: 'silent' } } as never),
      { notificationQueueUrl: url } as never,
    );
    const drain = async (): Promise<string[]> => {
      const statuses: string[] = [];
      for (let i = 0; i < 4 && statuses.length === 0; i++)
        for (const r of await consumer.consumeOnce(1, 0)) statuses.push(r.status);
      return statuses;
    };

    const transfer = { ...TRANSFER_SAMPLE, eventId: randomUUID() };
    await sqs.send(url, JSON.stringify(transfer));
    assert.deepEqual(await drain(), ['acknowledged']);
    const sent = await q(
      'SELECT user_id,kind,message FROM notification_log WHERE event_id=$1 ORDER BY id',
      [transfer.eventId],
    );
    assert.equal(sent.length, 2);
    assert.deepEqual(
      sent.map(r => r.user_id).sort(),
      [TRANSFER_SAMPLE.fromUserId, TRANSFER_SAMPLE.toUserId].sort(),
    );
    console.log('M-102-01 PASS: transfer -> 2 notification_log rows (sender, recipient)');
    for (const r of sent)
      console.log(`   ${String(r.user_id).slice(0, 8)}  ${String(r.kind)}  "${String(r.message)}"`);

    const lock = {
      ...ACCOUNT_LOCKED_SAMPLE,
      eventId: randomUUID(),
      note: 'Nghi ngờ gian lận, điểm rủi ro 90',
    };
    await sqs.send(url, JSON.stringify(lock));
    assert.deepEqual(await drain(), ['acknowledged']);
    const [notice] = await q(
      'SELECT user_id,kind,message FROM notification_log WHERE event_id=$1',
      [lock.eventId],
    );
    assert.equal(notice.user_id, ACCOUNT_LOCKED_SAMPLE.ownerUserId);
    assert.doesNotMatch(String(notice.message), /gian lận|nghi ngờ|lý do|rủi ro|fraud|reason/i);
    console.log(
      `M-102-02 PASS: lock notice for the owner has no reason: "${String(notice.message)}"`,
    );

    const orphan = { ...TRANSFER_SAMPLE, eventId: randomUUID(), toUserId: randomUUID() };
    await sqs.send(url, JSON.stringify(orphan));
    assert.deepEqual(await drain(), ['failed']);
    assert.deepEqual(await sqs.receive(url, { waitTimeSeconds: 0, visibilityTimeout: 0 }), []);
    const marks = await q('SELECT 1 FROM processed_events WHERE event_id=$1', [orphan.eventId]);
    assert.equal(marks.length, 0);
    console.log(
      'M-102-03 PASS: recipient missing -> failed, rolled back (no mark), message hidden by the 5 s backoff (immediate receive is empty)',
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
