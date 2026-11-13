/**
 * Manual driver (DBS-91): counts what is in an SQS queue per `eventId`.
 *
 *   SQS_ENDPOINT=http://localhost:9334 npx ts-node -r tsconfig-paths/register \
 *     test/manual/queue-census.ts http://localhost:9334/000000000000/risk-events
 *
 * It receives every message with a 30 s visibility timeout and deletes none of them, so the
 * messages are hidden from other readers for 30 s afterwards and then come back. Prints one JSON
 * line: how many messages, how many different eventIds, how many eventIds appear more than once.
 */
import { SqsClient } from '@libs/sqs';

async function main(): Promise<void> {
  const queue = process.argv[2];
  const endpoint = process.env.SQS_ENDPOINT;
  if (!queue || !endpoint) throw new Error('usage: SQS_ENDPOINT=<url> queue-census.ts <queue url>');
  process.env.AWS_ACCESS_KEY_ID ??= 'local';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'local';
  const sqs = new SqsClient({ region: 'us-east-1', endpoint });
  const counts = new Map<string, number>();
  let messages = 0;
  for (;;) {
    const batch = await sqs.receive(queue, { waitTimeSeconds: 1, visibilityTimeout: 30 });
    if (batch.length === 0) break;
    for (const message of batch) {
      messages += 1;
      const id = (JSON.parse(message.Body ?? '{}') as { eventId?: string }).eventId ?? '(none)';
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const duplicated = [...counts.values()].filter(count => count > 1).length;
  process.stdout.write(
    `${JSON.stringify({ queue: queue.split('/').pop(), messages, distinctEventIds: counts.size, duplicated })}\n`,
  );
  sqs.onApplicationShutdown();
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
