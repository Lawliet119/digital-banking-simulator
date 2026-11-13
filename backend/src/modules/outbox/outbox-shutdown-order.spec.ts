import { Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { PinoLogger } from 'nestjs-pino';
import { sqsConfig } from '@config/sqs.config';
import { ConsumerBase } from '@common/messaging/consumer-base';
import { OutboxRelayService } from './outbox-relay.service';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';

/** What the (mocked) AWS SDK saw, in order: 'Send:<queue>', 'Receive', 'Delete' and 'destroy'. */
const seen: string[] = [];
let sendGate: Promise<void> = Promise.resolve();
let receiveReply: unknown = { Messages: [] };
const sdkSend = jest.fn(async (command: { constructor: { name: string }; input: unknown }) => {
  const input = command.input as { QueueUrl?: string };
  const name = command.constructor.name.replace('Command', '');
  seen.push(name === 'SendMessage' ? `Send:${input.QueueUrl}` : name.replace('Message', ''));
  if (name === 'SendMessage') await sendGate;
  if (name === 'ReceiveMessage') {
    const reply = receiveReply;
    receiveReply = { Messages: [] }; // one batch only: the next poll would find nothing
    return reply;
  }
  return {};
});
jest.mock('@aws-sdk/client-sqs', () => ({
  ...jest.requireActual<typeof import('@aws-sdk/client-sqs')>('@aws-sdk/client-sqs'),
  SQSClient: jest.fn().mockImplementation(() => ({
    send: (...args: [never]) => sdkSend(...args),
    destroy: () => seen.push('destroy'),
  })),
}));

const RISK = 'http://queue/risk-events';
const NOTIFICATION = 'http://queue/notification-events';
const config = {
  region: 'us-east-1',
  endpoint: undefined,
  riskQueueUrl: RISK,
  notificationQueueUrl: NOTIFICATION,
};

/** Every gate is opened in afterEach, so a failed assertion cannot leave `close()` waiting. */
const gates: (() => void)[] = [];
function gate(): { open: Promise<void>; release: () => void } {
  let release!: () => void;
  const open = new Promise<void>(resolve => (release = resolve));
  gates.push(release);
  return { open, release };
}
const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise(r => setTimeout(r, 5));
  expect(condition()).toBe(true);
};
const pause = () => new Promise(resolve => setTimeout(resolve, 60));

/** A consumer whose handler waits on `handling`: the batch stays in flight until the test opens it. */
class SlowConsumer extends ConsumerBase {
  protected readonly consumerName = 'slow';
  handling: Promise<void> = Promise.resolve();
  constructor(tx: TransactionService, sqs: SqsClient) {
    super(tx, sqs, {} as PinoLogger);
  }
  protected queueUrl(): string {
    return RISK;
  }
  protected apply(): Promise<void> {
    return Promise.resolve();
  }
  override async handle(): Promise<void> {
    await this.handling;
  }
}

// SqsClient lives in its own module, as in the real app: the shutdown order must not depend on
// which module Nest destroys first.
@Module({
  providers: [{ provide: sqsConfig.KEY, useValue: config }, SqsClient],
  exports: [SqsClient],
})
class SqsStubModule {}

describe('BL-249 shutdown in the middle of a batch', () => {
  const originalRole = process.env.APP_ROLE;
  let app: TestingModule | undefined;
  const marked: string[][] = [];

  const event = (id: string) => ({
    id,
    event_type: 'TransferCompleted',
    payload: { eventId: `e${id}` },
  });

  /** A fake manager: the first poll returns the two events, the UPDATE is recorded. */
  function fakeTx(): TransactionService {
    let polled = false;
    const manager = {
      query: (sql: string, args: unknown[]) => {
        if (sql.startsWith('SELECT')) {
          const rows = polled ? [] : [event('1'), event('2')];
          polled = true;
          return Promise.resolve(rows);
        }
        marked.push(args[0] as string[]);
        return Promise.resolve([]);
      },
    };
    return { run: (work: (m: typeof manager) => Promise<unknown>) => work(manager) } as never;
  }

  beforeEach(() => {
    process.env.APP_ROLE = 'worker';
    seen.length = 0;
    marked.length = 0;
    sendGate = Promise.resolve();
    receiveReply = { Messages: [] };
  });

  afterEach(async () => {
    for (const release of gates.splice(0)) release();
    await app?.close();
    app = undefined;
    if (originalRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = originalRole;
  });

  it('relay: the SDK is destroyed only after the batch in flight has sent and committed', async () => {
    const hold = gate();
    sendGate = hold.open;
    @Module({
      imports: [SqsStubModule],
      providers: [
        { provide: TransactionService, useValue: fakeTx() },
        { provide: sqsConfig.KEY, useValue: config },
        OutboxRelayService,
      ],
    })
    class RelayModule {}
    app = await Test.createTestingModule({ imports: [RelayModule] }).compile();
    await app.init(); // starts the relay loop (worker role)
    await until(() => seen.includes(`Send:${RISK}`)); // first event, first queue: in flight

    const closing = app.close();
    await pause();
    expect(seen).not.toContain('destroy'); // SIGTERM did not pull the client from under the send

    hold.release();
    await closing;
    app = undefined;

    // The event on the wire finished both of its queues, event 2 was never started, the SDK went last.
    expect(seen).toEqual([`Send:${RISK}`, `Send:${NOTIFICATION}`, 'destroy']);
    expect(marked).toEqual([['1']]);
  });

  it('consumer: the SDK is destroyed only after the handler finished and the message was deleted', async () => {
    const hold = gate();
    receiveReply = { Messages: [{ MessageId: 'm1', Body: '{}', ReceiptHandle: 'r1' }] };
    @Module({
      imports: [SqsStubModule],
      providers: [
        { provide: TransactionService, useValue: {} },
        {
          provide: SlowConsumer,
          inject: [TransactionService, SqsClient],
          useFactory: (tx: TransactionService, sqs: SqsClient) => {
            const consumer = new SlowConsumer(tx, sqs);
            consumer.handling = hold.open;
            return consumer;
          },
        },
      ],
    })
    class ConsumerModule {}
    app = await Test.createTestingModule({ imports: [ConsumerModule] }).compile();
    await app.init();
    await until(() => seen.includes('Receive'));
    await pause(); // the handler is now waiting on `hold`

    const closing = app.close();
    await pause();
    expect(seen).toEqual(['Receive']); // no Delete yet, and no destroy

    hold.release();
    await closing;
    app = undefined;

    expect(seen).toEqual(['Receive', 'Delete', 'destroy']);
  });
});
