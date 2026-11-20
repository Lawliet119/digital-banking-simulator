/**
 * Manual driver for BL-360 and BL-372 (docs/features/BL-360-372-dlq-cli.md §5, M-BL-01..09).
 * It only feeds and reads two local ElasticMQ queues with synthetic messages; it writes no money,
 * touches no database, and the tools under test (`dlq:age-check`, `dlq:resend`) are run by hand.
 *
 *   export AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1
 *   export SQS_ENDPOINT=http://localhost:9324        # docker compose up -d elasticmq
 *   npx ts-node -r tsconfig-paths/register test/manual/dlq-cli.manual.ts seed
 *   ... add-stale <dlq url> | counts <queue url> | peek <queue url> | fill <queue url> | drain <queue url>
 *
 * `peek` receives with visibility 0 (messages stay), and prints the synthetic bodies on purpose.
 */
import { randomUUID } from 'node:crypto';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ORIGINAL_SENT_TIMESTAMP, PoisonMessageError, SqsClient } from '@libs/sqs';

const DAY = 24 * 60 * 60 * 1000;
const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:9324';
const sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1', endpoint });

/** A body the consumers accept (`validateEvent`), with this `eventId` and a marker for `kind`. */
const eventBody = (eventId: string, kind: string) =>
  JSON.stringify({ ...TRANSFER_SAMPLE, eventId, kind });

async function createQueue(name: string, attributes?: Record<string, string>): Promise<string> {
  const result = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
  );
  return new URL(new URL(result.QueueUrl!).pathname, endpoint).toString();
}

const stamp = (daysAgo: number) => ({
  [ORIGINAL_SENT_TIMESTAMP]: {
    DataType: 'Number',
    StringValue: String(Date.now() - daysAgo * DAY),
  },
});

async function seed(): Promise<void> {
  const suffix = Date.now().toString(36);
  const dlq = await createQueue(`dlqcli-dlq-${suffix}`);
  const otherDlq = await createQueue(`dlqcli-other-dlq-${suffix}`);
  const dlqArn = (
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }))
  ).Attributes?.QueueArn;
  // The source queue dead-letters to `dlq`: `dlq:resend` with another DLQ must refuse (B2 (c)).
  const main = await createQueue(`dlqcli-main-${suffix}`, {
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 100 }),
  });
  const [a, b, old] = [randomUUID(), randomUUID(), randomUUID()];
  const send = (
    body: string,
    attributes: Record<string, { DataType: string; StringValue: string }> = {},
  ) =>
    sqs.send(
      new SendMessageCommand({ QueueUrl: main, MessageBody: body, MessageAttributes: attributes }),
    );
  const corr = { correlationId: { DataType: 'String', StringValue: 'corr-' + suffix } };
  await send(eventBody(a, 'A'), { ...corr, ...stamp(2) });
  await send(eventBody(a, 'A'), { ...corr, ...stamp(3) }); // second copy of A
  await send(eventBody(b, 'B'), corr); // no attribute: the queue SentTimestamp is the age
  await send(eventBody(old, 'OLD'), stamp(7));
  await send('{not json');
  const adapter = new SqsClient({ region: 'us-east-1', endpoint });
  const poison = () => Promise.reject(new PoisonMessageError('manual test'));
  for (let i = 0; i < 6; i++) await adapter.processBatch(main, dlq, poison, { waitTimeSeconds: 1 });
  adapter.onApplicationShutdown();
  process.stdout.write(
    `${JSON.stringify({ main, dlq, otherDlq, eventIds: { A: a, B: b, OLD: old } }, null, 2)}\n`,
  );
}

async function addStale(dlq: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: dlq,
      MessageBody: eventBody(randomUUID(), 'STALE-2'),
      MessageAttributes: stamp(8),
    }),
  );
  process.stdout.write('added one message first sent 8 days ago\n');
}

async function counts(queue: string): Promise<void> {
  const result = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queue,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    }),
  );
  process.stdout.write(`${JSON.stringify(result.Attributes)}\n`);
}

async function peek(queue: string): Promise<void> {
  const adapter = new SqsClient({ region: 'us-east-1', endpoint });
  const seen = new Map<string, unknown>();
  // Two receives only: each one counts toward maxReceiveCount of the queue's RedrivePolicy.
  for (let i = 0; i < 2; i++) {
    for (const m of await adapter.receive(queue, { waitTimeSeconds: 1, visibilityTimeout: 0 })) {
      seen.set(m.MessageId!, {
        body: m.Body,
        attributes: Object.fromEntries(
          Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue]),
        ),
      });
    }
  }
  for (const entry of seen.values()) process.stdout.write(`${JSON.stringify(entry)}\n`);
  adapter.onApplicationShutdown();
}

async function fill(queue: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({ QueueUrl: queue, MessageBody: eventBody(randomUUID(), 'FILL') }),
  );
  process.stdout.write('added one message to the queue\n');
}

/** Deletes every message of a queue (the manual test only; never run it against a real DLQ). */
async function drain(queue: string): Promise<void> {
  let deleted = 0;
  for (let i = 0; i < 5; i++) {
    const result = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    for (const m of result.Messages ?? []) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: m.ReceiptHandle }));
      deleted++;
    }
  }
  process.stdout.write(`deleted ${deleted} message(s)\n`);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command === 'seed') await seed();
  else if (command === 'add-stale' && arg) await addStale(arg);
  else if (command === 'counts' && arg) await counts(arg);
  else if (command === 'peek' && arg) await peek(arg);
  else if (command === 'fill' && arg) await fill(arg);
  else if (command === 'drain' && arg) await drain(arg);
  else
    throw new Error(
      'usage: dlq-cli.manual.ts seed | add-stale <dlq> | counts <queue> | peek <queue> | fill <queue> | drain <queue>',
    );
  sqs.destroy();
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
