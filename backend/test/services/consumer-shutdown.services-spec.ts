import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { PinoLogger } from 'nestjs-pino';
import type { DomainEvent } from '@common/events';
import { ConsumerBase } from '@common/messaging';
import type { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import {
  localSqsClient,
  startElasticMqContainer,
  type StartedElasticMq,
} from '../support/elasticmq.container';

/**
 * BL-209: a consumer whose long poll (20 s) is waiting on an empty queue stops in moments, against
 * a real SQS protocol server. ECS gives the worker `stopTimeout` 60 s (the 30 s default before
 * DBS-121); the budget asserted here is the stricter of the two.
 */
describe('ConsumerBase shutdown during a real long poll (ElasticMQ)', () => {
  class IdleConsumer extends ConsumerBase {
    constructor(
      protected readonly consumerName: string,
      private readonly url: string,
      sqs: SqsClient,
    ) {
      super(
        {} as TransactionService,
        sqs,
        new PinoLogger({ pinoHttp: { level: 'silent' } } as never),
      );
    }
    protected queueUrl(): string {
      return this.url;
    }
    protected apply(_event: DomainEvent): Promise<void> {
      return Promise.resolve();
    }
  }

  const BUDGET_MS = 30_000;
  let mq: StartedElasticMq;
  let admin: ReturnType<typeof localSqsClient>;
  let sqs: SqsClient;
  let url: string;
  const created: string[] = [];
  const oldKey = process.env.AWS_ACCESS_KEY_ID;
  const oldSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const oldRole = process.env.APP_ROLE;

  async function queue(): Promise<string> {
    const result = await admin.send(new CreateQueueCommand({ QueueName: `bl209-${randomUUID()}` }));
    const made = new URL(new URL(result.QueueUrl!).pathname, mq.endpoint).toString();
    created.push(made);
    return made;
  }

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    process.env.APP_ROLE = 'worker';
    mq = await startElasticMqContainer();
    admin = localSqsClient(mq.endpoint);
    sqs = new SqsClient({ region: 'us-east-1', endpoint: mq.endpoint });
    url = await queue();
  });
  afterAll(async () => {
    try {
      for (const made of created) await admin.send(new DeleteQueueCommand({ QueueUrl: made }));
    } finally {
      sqs?.onApplicationShutdown();
      admin?.destroy();
      await mq?.stop();
      for (const [name, old] of [
        ['AWS_ACCESS_KEY_ID', oldKey],
        ['AWS_SECRET_ACCESS_KEY', oldSecret],
        ['APP_ROLE', oldRole],
      ] as const) {
        if (old === undefined) delete process.env[name];
        else process.env[name] = old;
      }
    }
  });

  it('TC-209-16 shutdown returns within seconds while a 20 s long poll is pending, and nothing is lost', async () => {
    const consumer = new IdleConsumer('bl209', url, sqs);
    consumer.onApplicationBootstrap();
    // The first receive is a 20 s long poll on an empty queue; give it time to be on the wire.
    await new Promise(resolve => setTimeout(resolve, 1000));

    const begun = Date.now();
    await consumer.beforeApplicationShutdown();
    const took = Date.now() - begun;
    expect(took).toBeLessThan(5_000);
    expect(took).toBeLessThan(BUDGET_MS);

    // Nothing is lost. The dropped long poll can still be registered on the server for a moment and
    // swallow the next message, which then stays invisible for its visibility timeout (30 s) and is
    // delivered again with its receive count raised by one; so count visible + in flight.
    await sqs.send(url, JSON.stringify({ hello: 'again' }));
    const counts = await admin.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    const total =
      Number(counts.Attributes?.ApproximateNumberOfMessages) +
      Number(counts.Attributes?.ApproximateNumberOfMessagesNotVisible);
    expect(total).toBe(1);
  }, 60_000);

  it('TC-209-17 a long poll aborted through SqsClient.receive rejects at once', async () => {
    const controller = new AbortController();
    const poll = sqs.receive(await queue(), {
      waitTimeSeconds: 20,
      abortSignal: controller.signal,
    });
    const begun = Date.now();
    setTimeout(() => controller.abort(), 300);
    await expect(poll).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - begun).toBeLessThan(5_000);
  }, 60_000);
});
