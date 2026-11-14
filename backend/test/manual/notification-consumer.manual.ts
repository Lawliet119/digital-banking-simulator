// From backend/: DATABASE_URL=<postgres server> npx ts-node -r tsconfig-paths/register test/manual/notification-consumer.manual.ts
// Needs `docker compose up -d` (ElasticMQ on :9324) and a PostgreSQL server for the throwaway DB.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import { NotificationConsumer } from '@modules/notification';
import { AuditService } from '@modules/audit';
import { ACCOUNT_LOCKED_SAMPLE, TRANSFER_SAMPLE } from '../support/event-samples';
import { drainStatuses, receiveBodies, until } from '../support/manual-wait';
import { createTempDatabase, migrate } from '../support/temp-database';

const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:9324';
process.env.AWS_ACCESS_KEY_ID = 'local';
process.env.AWS_SECRET_ACCESS_KEY = 'local';

/** M-102-06 only: no backoff, so the five receives of a failing message do not wait 150 s. */
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
      ACCOUNT_LOCKED_SAMPLE.ownerUserId,
    ])
      await q('INSERT INTO users(id,cognito_sub) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        id,
        randomUUID(),
      ]);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    const name = `dbs102-manual-${randomUUID()}`;
    const url = await create(name);
    const dlq = await create(`${name}-dlq`);
    const tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    const consumer = new NotificationConsumer(
      tx,
      sqs,
      { notificationQueueUrl: url } as never,
      new AuditService(tx),
    );
    const drain = (): Promise<string[]> => drainStatuses(consumer, 1);

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
      'M-102-03 PASS: recipient missing -> failed, rolled back (no mark), message hidden by the 10 s backoff (immediate receive is empty)',
    );

    // M-102-04 (BL-212): a redelivered duplicate is acknowledged and adds no row.
    await sqs.send(url, JSON.stringify(transfer));
    assert.deepEqual(await drainStatuses(consumer, 1), ['acknowledged']);
    const afterDup = await q('SELECT 1 FROM notification_log WHERE event_id=$1', [
      transfer.eventId,
    ]);
    assert.equal(afterDup.length, 2);
    console.log('M-102-04 PASS: same eventId again -> acknowledged, notification_log still 2 rows');

    // M-102-05 (BL-212): the recovery path. The missing user is created; once the 10 s backoff of
    // M-102-03 has passed (bounded wait), the same message is applied, once, with both notices.
    await q('INSERT INTO users(id,cognito_sub) VALUES($1,$2)', [orphan.toUserId, randomUUID()]);
    assert.deepEqual(await drainStatuses(consumer, 1, 20_000), ['acknowledged']);
    const recovered = await q('SELECT user_id FROM notification_log WHERE event_id=$1', [
      orphan.eventId,
    ]);
    assert.equal(recovered.length, 2);
    assert.equal(
      (await q('SELECT 1 FROM processed_events WHERE event_id=$1', [orphan.eventId])).length,
      1,
    );
    console.log(
      'M-102-05 PASS: user created, message came back after the backoff -> acknowledged, 2 rows, 1 processed_events',
    );

    // M-102-06 (BL-212): a message that never recovers is dead-lettered on the fifth receive.
    // Backoff off, so the five receives take seconds, not minutes.
    const quick = new NoBackoffNotification(
      tx,
      sqs,
      { notificationQueueUrl: url } as never,
      new AuditService(tx),
    );
    const doomed = { ...TRANSFER_SAMPLE, eventId: randomUUID(), toUserId: randomUUID() };
    await sqs.send(url, JSON.stringify(doomed));
    const attempts: string[] = [];
    await until(async () => {
      for (const r of await quick.consumeOnce(1, 0)) attempts.push(r.status);
      return attempts.includes('dead-lettered');
    }, 'the fifth receive to dead-letter the message');
    assert.deepEqual(attempts, ['failed', 'failed', 'failed', 'failed', 'dead-lettered']);
    const [forwarded] = await receiveBodies(sqs, dlq, 1);
    assert.equal((JSON.parse(forwarded) as { eventId: string }).eventId, doomed.eventId);
    assert.equal(
      (await q('SELECT 1 FROM notification_log WHERE event_id=$1', [doomed.eventId])).length,
      0,
    );
    console.log(
      `M-102-06 PASS: ${attempts.join(',')}; message in notification DLQ; nothing written`,
    );

    // M-102-07 (BL-212): a poison body goes to the DLQ at the first receive.
    await sqs.send(url, JSON.stringify({ eventType: 'TransferCompleted' }));
    assert.deepEqual(await drainStatuses(consumer, 1), ['dead-lettered']);
    assert.deepEqual(await receiveBodies(sqs, dlq, 1), ['{"eventType":"TransferCompleted"}']);
    console.log('M-102-07 PASS: schema-breaking body -> DLQ at the first receive');
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
