import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { ORIGINAL_SENT_TIMESTAMP, PoisonMessageError, SqsClient } from '@libs/sqs';
import { runDlqResendCli } from '../../src/scripts/dlq-resend';
import {
  startElasticMqContainer,
  localSqsClient,
  type StartedElasticMq,
} from '../support/elasticmq.container';

const DAY = 24 * 60 * 60 * 1000;

/** BL-372 on the real SQS protocol: a dead-lettered message goes back with its body, attributes and first send time. */
describe('BL-372 dlq:resend on ElasticMQ', () => {
  let mq: StartedElasticMq;
  let adapter: SqsClient;
  let admin: ReturnType<typeof localSqsClient>;
  let queues: string[];
  let source: string;
  let dlq: string;
  let dir: string;
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
    dir = mkdtempSync(join(tmpdir(), 'bl372-'));
    const create = async () => {
      const result = await admin.send(
        new CreateQueueCommand({ QueueName: 'bl372-' + randomUUID() }),
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
    rmSync(dir, { recursive: true, force: true });
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
  const deadLetterAll = async (expected: number) => {
    for (let i = 0; i < 6 && (await visibleIn(dlq)) < expected; i++)
      await adapter.processBatch(source, dlq, poison, { waitTimeSeconds: 1 });
    expect(await visibleIn(dlq)).toBe(expected);
  };
  const resend = async (record: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runDlqResendCli(
      [
        '--from-dlq',
        dlq,
        '--to-queue',
        source,
        '--endpoint-url',
        mq.endpoint,
        '--record-file',
        record,
        '--all',
      ],
      {
        stdout: t => out.push(t),
        stderr: t => err.push(t),
        env: { AWS_REGION: 'us-east-1' },
        now: () => Date.now(),
      },
    );
    return { code, out: out.join(''), err: err.join('') };
  };

  it('TC-BL-17 the valid message goes back with body, attributes and first send time; the 7-day-old one stays', async () => {
    const okId = randomUUID();
    const oldId = randomUUID();
    const firstSend = Date.now() - 2 * DAY;
    const okBody = JSON.stringify({ eventId: okId, amount: '500000' });
    await admin.send(
      new SendMessageCommand({
        QueueUrl: source,
        MessageBody: okBody,
        MessageAttributes: {
          correlationId: { DataType: 'String', StringValue: 'corr-372' },
          [ORIGINAL_SENT_TIMESTAMP]: { DataType: 'Number', StringValue: String(firstSend) },
        },
      }),
    );
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
    await deadLetterAll(2);

    const record = join(dir, 'nested', 'record.jsonl');
    const result = await resend(record);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      scanned: 2,
      resent: 1,
      skipped: [expect.objectContaining({ eventId: oldId, reason: 'stale' })],
      failed: [],
      complete: true,
    });
    expect(result.out).not.toContain('500000');

    const [back] = await adapter.receive(source, opts);
    expect(back.Body).toBe(okBody);
    expect(back.MessageAttributes?.correlationId?.StringValue).toBe('corr-372');
    expect(back.MessageAttributes?.[ORIGINAL_SENT_TIMESTAMP]).toEqual(
      expect.objectContaining({ DataType: 'Number', StringValue: String(firstSend) }),
    );
    expect(await visibleIn(source)).toBe(1);

    // The DLQ keeps only the stale one, handed back and visible.
    const left = await adapter.receive(dlq, opts);
    expect(left.map(m => (JSON.parse(m.Body!) as { eventId: string }).eventId)).toEqual([oldId]);
    const lines = readFileSync(record, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ action: 'resent', eventId: okId });
    expect(lines[0]).not.toContain('500000');
  });

  it('TC-BL-18 a message with no attribute keeps the queue send time across the dead-letter, the resend and a second dead-letter', async () => {
    const eventId = randomUUID();
    const before = Date.now();
    await adapter.send(source, JSON.stringify({ eventId }));
    await deadLetterAll(1);
    const [firstCopy] = await adapter.receive(dlq, opts);
    const firstSend = Number(firstCopy.MessageAttributes?.[ORIGINAL_SENT_TIMESTAMP]?.StringValue);
    expect(firstSend).toBeGreaterThanOrEqual(before - 1000);

    const result = await resend(join(dir, 'r.jsonl'));
    expect(result.code).toBe(0);
    expect(await visibleIn(dlq)).toBe(0);

    // The consumer still cannot handle it: it goes to the DLQ again with the same first send time.
    await deadLetterAll(1);
    const [secondCopy] = await adapter.receive(dlq, opts);
    expect(secondCopy.MessageAttributes?.[ORIGINAL_SENT_TIMESTAMP]?.StringValue).toBe(
      String(firstSend),
    );
  });
});
