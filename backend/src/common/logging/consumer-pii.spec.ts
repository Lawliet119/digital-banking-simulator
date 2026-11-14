import { Logger as NestLogger } from '@nestjs/common';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { Logger, PinoLogger } from 'nestjs-pino';
import type { EntityManager } from 'typeorm';
import type { TransactionService } from '@database/transaction.service';
import type { DomainEvent } from '@common/events';
import { ConsumerBase } from '@common/messaging/consumer-base';
import type { SqsClient, SqsMessage } from '@libs/sqs';
import { TRANSFER_SAMPLE } from '../../../test/support/event-samples';
import { createLoggingOptions } from './logging.options';
import { SafeLogger } from './safe-logger';

/** BL-024 (4): a consumer never writes personal data (`customers.full_name`) to a log line. */
const NAME = 'Nguyễn Minh Anh';
const NAME_TOKEN = 'Minh Anh';

describe('BL-024 consumers do not log personal data', () => {
  let output = '';
  let pino: PinoLogger;
  const changeVisibility = jest.fn();

  class NameLeakingConsumer extends ConsumerBase {
    protected readonly consumerName = 'pii-probe';
    mode: 'log-fields' | 'throw' | 'assign' = 'log-fields';
    private readonly own = new NestLogger('PiiProbe');
    constructor() {
      const tx = {
        run: <T>(fn: (manager: EntityManager) => Promise<T>) =>
          fn({ query: () => Promise.resolve([{ event_id: 'x' }]) } as unknown as EntityManager),
      } as unknown as TransactionService;
      super(tx, { changeVisibility } as unknown as SqsClient);
    }
    protected queueUrl(): string {
      return 'http://localhost:9324/000000000000/pii-events';
    }
    protected override get retryBackoffSeconds(): number {
      return 5;
    }
    protected apply(event: DomainEvent): Promise<void> {
      if (this.mode === 'throw')
        return Promise.reject(new Error(`customer ${NAME} not found for ${event.eventId}`));
      if (this.mode === 'assign') pino.assign({ fullName: NAME, full_name: NAME });
      // What a careless handler would write after reading a customer row.
      this.own.log({ fullName: NAME, full_name: NAME, ownerName: NAME }, 'Customer read');
      pino.logger.info({ customer: { fullName: NAME } }, 'Customer read');
      return Promise.resolve();
    }
  }

  beforeAll(() => {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString();
        done();
      },
    });
    pino = new PinoLogger({
      pinoHttp: [createLoggingOptions({ role: 'both', logLevel: 'verbose' }), stream],
    });
    NestLogger.overrideLogger(new SafeLogger(new Logger(pino, {})));
  });
  afterAll(() => {
    NestLogger.overrideLogger(false);
  });
  beforeEach(() => {
    output = '';
    changeVisibility.mockReset();
    changeVisibility.mockRejectedValue(new Error(`queue refused ${NAME}`));
  });

  const message: SqsMessage = { MessageId: 'm', Attributes: { ApproximateReceiveCount: '1' } };

  it('redacts a name a handler puts in a log object, at any depth', async () => {
    await new NameLeakingConsumer().handle(TRANSFER_SAMPLE, message);
    expect(output).not.toContain(NAME);
    expect(output).not.toContain(NAME_TOKEN);
    const logged = output
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(logged.length).toBeGreaterThanOrEqual(2);
    for (const row of logged) expect(row).toMatchObject({ role: 'worker' });
  });

  it('keeps a name out of the failure and backoff lines, whatever the error message says', async () => {
    const consumer = new NameLeakingConsumer();
    consumer.mode = 'throw';
    await expect(consumer.handle(TRANSFER_SAMPLE, message)).rejects.toThrow();
    expect(output).toContain('backoff not applied');
    expect(output).not.toContain(NAME);
    expect(output).not.toContain(NAME_TOKEN);
  });

  it('keeps a name that other code assigns to the context out of every later line', async () => {
    const consumer = new NameLeakingConsumer();
    consumer.mode = 'assign';
    await consumer.handle(TRANSFER_SAMPLE, message);
    expect(output).not.toContain(NAME);
  });

  it('keeps the consumers from reading the customers table at all', () => {
    const files = sources(resolve(__dirname, '../../modules')).filter(file =>
      /\.consumer\.ts$/.test(file),
    );
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of [...files, resolve(__dirname, '../messaging/consumer-base.ts')])
      expect(withoutComments(readFileSync(file, 'utf8'))).not.toMatch(
        /full_?name|\bcustomers\b|ownerName/i,
      );
  });
});

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : [path];
  });
}
