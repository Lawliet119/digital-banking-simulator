import { Logger } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { TransactionService } from '@database/transaction.service';
import type { SqsClient } from '@libs/sqs';
import { ConsumerBase } from './consumer-base';

class PollingConsumer extends ConsumerBase {
  protected readonly consumerName = 'shutdown';
  constructor(sqs: SqsClient) {
    super(
      {} as TransactionService,
      sqs,
      new PinoLogger({ pinoHttp: { level: 'silent' } } as never),
    );
  }
  protected queueUrl(): string | undefined {
    return 'http://localhost:9324/000000000000/shutdown-events';
  }
  protected apply(): Promise<void> {
    return Promise.resolve();
  }
}

/** A long poll that never returns a message and ends only when its signal aborts, like the SDK's. */
function pendingLongPoll(): { sqs: SqsClient; started: Promise<void>; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  let begin!: () => void;
  const started = new Promise<void>(resolve => (begin = resolve));
  const processBatch = jest.fn(
    (_queue: string, _dlq: string, _handler: unknown, options: { abortSignal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        const signal = options.abortSignal;
        if (signal) signals.push(signal);
        begin();
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })),
        );
      }),
  );
  return { sqs: { processBatch } as unknown as SqsClient, started, signals };
}

describe('BL-209 ConsumerBase shutdown while a long poll is waiting', () => {
  const oldRole = process.env.APP_ROLE;
  afterEach(() => {
    if (oldRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = oldRole;
    jest.restoreAllMocks();
  });

  it('TC-209-10 beforeApplicationShutdown cancels the poll and returns at once, with no error logged', async () => {
    process.env.APP_ROLE = 'worker';
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { sqs, started, signals } = pendingLongPoll();
    const consumer = new PollingConsumer(sqs);
    consumer.onApplicationBootstrap();
    await started;
    expect(signals[0].aborted).toBe(false);

    const begun = Date.now();
    await consumer.beforeApplicationShutdown();
    expect(Date.now() - begun).toBeLessThan(1000);
    expect(signals[0].aborted).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it('TC-209-11 a consumer that never started has nothing to cancel, and stopping it is harmless', async () => {
    const { sqs } = pendingLongPoll();
    await expect(new PollingConsumer(sqs).beforeApplicationShutdown()).resolves.toBeUndefined();
  });

  it('TC-209-12 a poll that fails for another reason while running is still reported', async () => {
    process.env.APP_ROLE = 'worker';
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const processBatch = jest.fn().mockRejectedValue(new Error('queue unreachable'));
    const consumer = new PollingConsumer({ processBatch } as unknown as SqsClient);
    consumer.onApplicationBootstrap();
    await new Promise(resolve => setTimeout(resolve, 50));
    await consumer.beforeApplicationShutdown();
    expect(error).toHaveBeenCalledWith(expect.anything(), 'shutdown consumer failed');
  });
});
