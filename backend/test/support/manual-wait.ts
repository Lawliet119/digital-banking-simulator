import { setTimeout as wait } from 'node:timers/promises';
import type { BatchResult, SqsClient } from '@libs/sqs';

/**
 * Bounded waiting for the manual scripts (BL-212): a script that waits on a queue, a consumer or a
 * cache never loops without an end. Every helper stops with an error that names what it waited for.
 */

/** Polls `check` every `everyMs` until it returns true; throws after `timeoutMs`. */
export async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 15_000,
  everyMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await wait(everyMs);
  }
}

/**
 * Reads `expected` bodies from a queue (a DLQ, usually), receiving again while the first reads come
 * back short: SQS may return fewer messages than are on the queue. Deletes what it read, so a
 * second call sees only what arrived since. Throws when fewer arrive within `timeoutMs`.
 */
export async function receiveBodies(
  sqs: SqsClient,
  queue: string,
  expected: number,
  timeoutMs = 15_000,
): Promise<string[]> {
  const bodies: string[] = [];
  await until(
    async () => {
      const batch = await sqs.receive(queue, {
        maxMessages: 10,
        waitTimeSeconds: 1,
        visibilityTimeout: 30,
      });
      for (const message of batch) {
        bodies.push(message.Body!);
        await sqs.acknowledge(queue, message);
      }
      return bodies.length >= expected;
    },
    `${expected} message(s) on ${queue} (got ${bodies.length})`,
    timeoutMs,
    0,
  );
  return bodies;
}

/** Calls `consumeOnce(1, 0)` until `expected` results arrived (short batches happen); bounded. */
export async function drainStatuses(
  consumer: {
    consumeOnce(waitTimeSeconds?: number, visibilityTimeout?: number): Promise<BatchResult[]>;
  },
  expected: number,
  timeoutMs = 20_000,
): Promise<string[]> {
  const statuses: string[] = [];
  await until(
    async () => {
      for (const result of await consumer.consumeOnce(1, 0)) statuses.push(result.status);
      return statuses.length >= expected;
    },
    `${expected} result(s) from the consumer (got ${statuses.join(',') || 'none'})`,
    timeoutMs,
    0,
  );
  return statuses;
}
