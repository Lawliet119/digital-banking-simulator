import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { SqsClient } from '@libs/sqs';
import {
  startElasticMqContainer,
  localSqsClient,
  type StartedElasticMq,
} from '../support/elasticmq.container';

describe('DBS-77 real SQS protocol on ElasticMQ', () => {
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
        new CreateQueueCommand({ QueueName: 'dbs77-' + randomUUID() }),
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
  const opts = { waitTimeSeconds: 1, visibilityTimeout: 0 };
  it('TC-77-02 roundtrips String attributes; receive does not acknowledge', async () => {
    await adapter.send(source, '{"amount":"9007199254740993"}', { correlationId: 'server-77' });
    const [first] = await adapter.receive(source, opts);
    expect(first.Body).toBe('{"amount":"9007199254740993"}');
    expect(first.MessageAttributes?.correlationId.StringValue).toBe('server-77');
    expect(first.ReceiptHandle).toBeTruthy();
    const [again] = await adapter.receive(source, opts);
    expect(again.MessageId).toBe(first.MessageId);
    await adapter.acknowledge(source, again);
    expect(await adapter.receive(source, opts)).toEqual([]);
  });
  it('TC-77-03/05 handles a real multi-message batch and isolates failed handlers', async () => {
    for (let i = 0; i < 3; i++) await adapter.send(source, JSON.stringify({ id: i }));
    const seen: number[] = [];
    const failed: string[] = [];
    let largestBatch = 0;
    // SQS may legally return a short batch, so drain until all distinct messages were observed.
    for (let attempt = 0; attempt < 5 && new Set(seen).size < 3; attempt++) {
      const results = await adapter.processBatch(
        source,
        dlq,
        body => {
          const id = (body as { id: number }).id;
          seen.push(id);
          if (id === 1) return Promise.reject(new Error('handler unavailable'));
          return Promise.resolve();
        },
        { waitTimeSeconds: 1, visibilityTimeout: 1 },
      );
      failed.push(...results.filter(r => r.status === 'failed').map(r => r.messageId!));
      largestBatch = Math.max(largestBatch, results.length);
    }
    expect(new Set(seen)).toEqual(new Set([0, 1, 2]));
    expect(failed.length).toBeGreaterThan(0);
    expect(largestBatch).toBeGreaterThan(1);
    const [again] = await adapter.receive(source, { waitTimeSeconds: 2, visibilityTimeout: 0 });
    expect(JSON.parse(again.Body!)).toEqual({ id: 1 });
    expect(failed).toContain(again.MessageId);
    await adapter.acknowledge(source, again);
    expect(await adapter.receive(source, opts)).toEqual([]);
  });
  it('TC-77-03 does not delete before asynchronous handler completes', async () => {
    await adapter.send(source, '{}');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const ready = new Promise<void>(r => {
      entered = r;
    });
    const processing = adapter.processBatch(
      source,
      dlq,
      async () => {
        entered();
        await gate;
      },
      { waitTimeSeconds: 1, visibilityTimeout: 30 },
    );
    try {
      await ready;
      const result = await admin.send(
        new GetQueueAttributesCommand({
          QueueUrl: source,
          AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      expect(result.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe('1');
    } finally {
      release();
      await processing;
    }
    expect(await adapter.receive(source, opts)).toEqual([]);
  });
  it('TC-77-04 routes malformed JSON unchanged to DLQ without calling business handler', async () => {
    await adapter.send(source, '{', { correlationId: 'server-77' });
    const handler = jest.fn();
    const result = await adapter.processBatch(source, dlq, handler, opts);
    expect(result[0].status).toBe('dead-lettered');
    expect(handler).not.toHaveBeenCalled();
    expect(await adapter.receive(source, opts)).toEqual([]);
    const [bad] = await adapter.receive(dlq, opts);
    expect(bad.Body).toBe('{');
    expect(bad.MessageAttributes?.correlationId.StringValue).toBe('server-77');
  });
  it('TC-77-04 preserves malformed source when DLQ is unavailable', async () => {
    await adapter.send(source, '{');
    const results = await adapter.processBatch(
      source,
      `${dlq}-missing`,
      () => Promise.resolve(),
      opts,
    );
    expect(results[0].status).toBe('failed');
    const [again] = await adapter.receive(source, opts);
    expect(again.MessageId).toBe(results[0].messageId);
    expect(again.Body).toBe('{');
  });
});
