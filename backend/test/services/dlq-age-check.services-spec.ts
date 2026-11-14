import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { ORIGINAL_SENT_TIMESTAMP, PoisonMessageError, SqsClient } from '@libs/sqs';
import { awsDlqPort, runDlqAgeCheck, runDlqAgeCheckCli } from '../../src/scripts/dlq-age-check';
import {
  startElasticMqContainer,
  localSqsClient,
  type StartedElasticMq,
} from '../support/elasticmq.container';

const DAY = 24 * 60 * 60 * 1000;

/** BL-210 on the real SQS protocol: the DLQ copy keeps its first send time, and the age check reads it. */
describe('BL-210 DLQ age on ElasticMQ', () => {
  let mq: StartedElasticMq;
  let adapter: SqsClient;
  let admin: ReturnType<typeof localSqsClient>;
  let queues: string[];
  let source: string;
  let dlq: string;
  const oldKey = process.env.AWS_ACCESS_KEY_ID;
  const oldSecret = process.env.AWS_SECRET_ACCESS_KEY;
  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    mq = await startElasticMqContainer();
    admin = localSqsClient(mq.endpoint);
    adapter = new SqsClient({ region: 'us-east-1', endpoint: mq.endpoint });
  });
  afterAll(async () => {
    adapter?.onApplicationShutdown();
    admin?.destroy();
    await mq?.stop();
    if (oldKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = oldKey;
    if (oldSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = oldSecret;
  });
  beforeEach(async () => {
    queues = [];
    const create = async () => {
      const result = await admin.send(
        new CreateQueueCommand({ QueueName: 'bl210-' + randomUUID() }),
      );
      const url = new URL(new URL(result.QueueUrl!).pathname, mq.endpoint).toString();
      queues.push(url);
      return url;
    };
    source = await create();
    dlq = await create();
  });
  afterEach(async () => {
    for (const url of queues) await admin.send(new DeleteQueueCommand({ QueueUrl: url }));
  });

  const poison = () => Promise.reject(new PoisonMessageError('invalid schema'));
  const opts = { waitTimeSeconds: 1, visibilityTimeout: 0 };
  const visibleIn = async (url: string) =>
    Number(
      (
        await admin.send(
          new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: ['ApproximateNumberOfMessages'],
          }),
        )
      ).Attributes?.ApproximateNumberOfMessages,
    );

  it('TC-210-19 a dead-lettered message carries the SentTimestamp of its first send', async () => {
    const before = Date.now();
    await adapter.send(source, JSON.stringify({ eventId: randomUUID() }));
    const [received] = await adapter.receive(source, opts);
    // The queue reports the send time as a system attribute because receive asks for it.
    const sentAt = Number(received.Attributes?.SentTimestamp);
    expect(sentAt).toBeGreaterThanOrEqual(before - 1000);

    await adapter.processBatch(source, dlq, poison, { waitTimeSeconds: 1 });
    const [copy] = await adapter.receive(dlq, opts);
    expect(copy.MessageAttributes?.[ORIGINAL_SENT_TIMESTAMP]).toEqual(
      expect.objectContaining({ DataType: 'Number', StringValue: String(sentAt) }),
    );
  });

  it('TC-210-20 a replayed message that is dead-lettered again keeps its first send time, not the replay time', async () => {
    const firstSend = Date.now() - 3 * DAY;
    await admin.send(
      new SendMessageCommand({
        QueueUrl: source,
        MessageBody: '{"replayed":true}',
        MessageAttributes: {
          [ORIGINAL_SENT_TIMESTAMP]: { DataType: 'Number', StringValue: String(firstSend) },
        },
      }),
    );
    await adapter.processBatch(source, dlq, poison, { waitTimeSeconds: 1 });
    const [copy] = await adapter.receive(dlq, opts);
    expect(copy.MessageAttributes?.[ORIGINAL_SENT_TIMESTAMP]?.StringValue).toBe(String(firstSend));
  });

  it('TC-210-21 the check finds the message first sent 7 days ago, saves and deletes it, and hands the fresh one back', async () => {
    const freshId = randomUUID();
    const oldId = randomUUID();
    await adapter.send(source, JSON.stringify({ eventId: freshId }));
    await admin.send(
      new SendMessageCommand({
        QueueUrl: source,
        MessageBody: JSON.stringify({ eventId: oldId }),
        MessageAttributes: {
          [ORIGINAL_SENT_TIMESTAMP]: {
            DataType: 'Number',
            StringValue: String(Date.now() - 7 * DAY),
          },
        },
      }),
    );
    // Both go through the real consumer path into the DLQ.
    for (let i = 0; i < 4 && (await visibleIn(dlq)) < 2; i++)
      await adapter.processBatch(source, dlq, poison, { waitTimeSeconds: 1 });
    expect(await visibleIn(dlq)).toBe(2);

    const port = awsDlqPort(admin, dlq);
    const saved: string[] = [];
    const report = await runDlqAgeCheck(port, {
      now: Date.now(),
      maxAgeMs: 6 * DAY,
      deleteStale: true,
      saveStale: messages => {
        saved.push(...messages.map(m => m.Body ?? ''));
      },
    });
    expect(report).toMatchObject({ checked: 2, fresh: 1, deleted: 1, complete: true, failed: [] });
    expect(report.stale).toEqual([
      expect.objectContaining({ eventId: oldId, ageHours: expect.any(Number) }),
    ]);
    expect(saved).toEqual([JSON.stringify({ eventId: oldId })]);

    // What is left is visible again (ready for the redrive) and is the fresh message only.
    const left = await adapter.receive(dlq, opts);
    expect(left.map(m => (JSON.parse(m.Body!) as { eventId: string }).eventId)).toEqual([freshId]);
  });

  it('TC-210-22 the command reports without deleting and exits 1 while a stale message remains', async () => {
    await admin.send(
      new SendMessageCommand({
        QueueUrl: dlq,
        MessageBody: JSON.stringify({ eventId: randomUUID() }),
        MessageAttributes: {
          [ORIGINAL_SENT_TIMESTAMP]: {
            DataType: 'Number',
            StringValue: String(Date.now() - 8 * DAY),
          },
        },
      }),
    );
    const out: string[] = [];
    const code = await runDlqAgeCheckCli(['--queue-url', dlq, '--endpoint-url', mq.endpoint], {
      stdout: t => out.push(t),
      stderr: () => undefined,
      env: { AWS_REGION: 'us-east-1' },
      now: () => Date.now(),
    });
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toMatchObject({ checked: 1, fresh: 0, deleted: 0 });
    // Handed back: still there and visible.
    expect(await adapter.receive(dlq, opts)).toHaveLength(1);
  });
});
