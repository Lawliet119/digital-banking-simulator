/**
 * Test-only child process (DBS-91): runs ONE outbox relay batch against the database and queues
 * named in the environment and then stops at a chosen point, so the parent can kill it for real
 * (SIGKILL) while its transaction is open.
 *
 *   node -r ts-node/register -r tsconfig-paths/register test/support/relay-crash-child.ts <mode>
 *
 * `before-send`: prints `READY` and hangs just before the first message is sent.
 * `after-send`:  sends every message for real, prints `READY` after the last one and hangs, so the
 *                relay never gets to its UPDATE or COMMIT. `EXPECT_SENDS` is that number of sends.
 *
 * Its database connections carry application_name `dbs91-relay-child`, so the parent can see when
 * PostgreSQL has noticed the dead client and released the row locks.
 */
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import { OutboxRelayService } from '@modules/outbox';
import { CHILD_APPLICATION_NAME } from './relay-crash-name';

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'before-send' && mode !== 'after-send') throw new Error(`Unknown mode ${mode}`);
  const env = (key: string): string => {
    const value = process.env[key];
    if (!value) throw new Error(`${key} is required`);
    return value;
  };
  const source = new DataSource({
    type: 'postgres',
    url: env('DATABASE_URL'),
    extra: { application_name: CHILD_APPLICATION_NAME },
  });
  await source.initialize();
  const real = new SqsClient({ region: 'us-east-1', endpoint: env('SQS_ENDPOINT') });
  const expected = Number(process.env.EXPECT_SENDS ?? '0');
  let sent = 0;
  const hang = (): Promise<never> => {
    process.stdout.write('READY\n');
    return new Promise<never>(() => undefined);
  };
  const send: SqsClient['send'] = async (queue, body, attributes, options) => {
    if (mode === 'before-send') return hang();
    await real.send(queue, body, attributes, options);
    sent += 1;
    if (sent === expected) return hang();
  };
  const relay = new OutboxRelayService(
    new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 60000,
    } as never),
    { send } as unknown as SqsClient,
    {
      region: 'us-east-1',
      endpoint: env('SQS_ENDPOINT'),
      riskQueueUrl: env('SQS_RISK_QUEUE_URL'),
      notificationQueueUrl: env('SQS_NOTIFICATION_QUEUE_URL'),
    },
  );
  await relay.relayOnce();
  // Only reached when the mode did not stop the batch (EXPECT_SENDS too high): not a crash test.
  process.stdout.write('DONE\n');
  await source.destroy();
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
