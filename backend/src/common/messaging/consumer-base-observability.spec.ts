import { Logger } from '@nestjs/common';
import { Counter, register } from 'prom-client';
import type { EntityManager } from 'typeorm';
import type { TransactionService } from '@database/transaction.service';
import type { DomainEvent } from '@common/events';
import { PoisonMessageError, type SqsClient, type SqsMessage } from '@libs/sqs';
import { TRANSFER_SAMPLE } from '../../../test/support/event-samples';
import { ConsumerBase, MAX_ATTEMPTS, type UnknownEventPolicy } from './consumer-base';
import { CONSUMER_MESSAGE_METRIC, countConsumerMessage } from './consumer.metrics';

const SECRET = 'secret-body-text-4242';

class ObservedConsumer extends ConsumerBase {
  protected readonly consumerName = 'observed';
  failure: Error | undefined;
  policy: UnknownEventPolicy = 'dead-letter';
  constructor(tx: TransactionService, sqs: SqsClient) {
    super(tx, sqs);
  }
  protected override get retryBackoffSeconds(): number {
    return 0;
  }
  protected override get unknownEventPolicy(): UnknownEventPolicy {
    return this.policy;
  }
  protected queueUrl(): string | undefined {
    return 'http://localhost:9324/000000000000/observed-events';
  }
  protected apply(): Promise<void> {
    return this.failure === undefined ? Promise.resolve() : Promise.reject(this.failure);
  }
}

describe('BL-209 ConsumerBase logs and counts every retry and dead-letter', () => {
  const tx = {
    run: <T>(fn: (m: EntityManager) => Promise<T>) =>
      fn({ query: () => Promise.resolve([{ event_id: 'x' }]) } as unknown as EntityManager),
  } as unknown as TransactionService;
  const message = (receiveCount: number, id = 'sqs-msg-1'): SqsMessage => ({
    MessageId: id,
    Attributes: { ApproximateReceiveCount: String(receiveCount) },
  });
  const event = { ...TRANSFER_SAMPLE, extension: SECRET } as unknown as DomainEvent;
  let consumer: ObservedConsumer;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  const counts = async (): Promise<Record<string, number>> => {
    const metric = register.getSingleMetric(CONSUMER_MESSAGE_METRIC);
    if (!(metric instanceof Counter)) throw new Error('counter missing');
    return Object.fromEntries(
      (await metric.get()).values.map(v => [`${v.labels.consumer}/${v.labels.outcome}`, v.value]),
    );
  };
  const logged = (spy: jest.SpyInstance) => JSON.stringify(spy.mock.calls);

  beforeEach(() => {
    const metric = register.getSingleMetric(CONSUMER_MESSAGE_METRIC);
    if (metric instanceof Counter) metric.reset();
    consumer = new ObservedConsumer(tx, {} as SqsClient);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('TC-209-02 a transient apply failure logs consumer, eventId, receiveCount and the error class, and counts a retry', async () => {
    consumer.failure = Object.assign(new Error(`connection lost ${SECRET}`), { code: '40001' });
    await expect(consumer.handle(event, message(2))).rejects.toBe(consumer.failure);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, text] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({
      consumer: 'observed',
      outcome: 'retry',
      eventId: TRANSFER_SAMPLE.eventId,
      receiveCount: 2,
      errorType: 'Error',
      code: '40001',
    });
    expect(text).toBe('observed message will be retried');
    expect(error).not.toHaveBeenCalled();
    expect(await counts()).toEqual({ 'observed/retry': 1 });
    // Never the body, never the error message.
    expect(logged(warn)).not.toContain(SECRET);
  });

  it('TC-209-03 a permanent apply failure such as a foreign-key violation shows its SQLSTATE on the retry', async () => {
    consumer.failure = Object.assign(new Error(`Key (x)=(${SECRET}) is not present`), {
      code: '23503',
    });
    await expect(consumer.handle(event, message(1))).rejects.toBeDefined();
    expect(warn.mock.calls[0][0]).toMatchObject({
      outcome: 'retry',
      code: '23503',
      receiveCount: 1,
    });
    expect(logged(warn)).not.toContain(SECRET);
  });

  it('TC-209-04 the last receive dead-letters: an error line with the same fields, and a dead_letter count', async () => {
    consumer.failure = Object.assign(new Error('boom'), { code: '40P01' });
    await expect(consumer.handle(event, message(MAX_ATTEMPTS))).rejects.toBeInstanceOf(
      PoisonMessageError,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const [fields, text] = error.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({
      consumer: 'observed',
      outcome: 'dead_letter',
      eventId: TRANSFER_SAMPLE.eventId,
      receiveCount: MAX_ATTEMPTS,
      reason: 'attempts_exhausted',
      errorType: 'Error',
      code: '40P01',
    });
    expect(text).toBe('observed message dead-lettered');
    expect(await counts()).toEqual({ 'observed/dead_letter': 1 });
  });

  it('TC-209-05 a PoisonMessageError from apply is logged with the SQLSTATE of its cause', async () => {
    consumer.failure = new PoisonMessageError('Event refers to a missing row', {
      cause: Object.assign(new Error(SECRET), { code: '23503' }),
    });
    await expect(consumer.handle(event, message(1))).rejects.toBeInstanceOf(PoisonMessageError);
    expect(error.mock.calls[0][0]).toMatchObject({
      outcome: 'dead_letter',
      reason: 'poison',
      eventId: TRANSFER_SAMPLE.eventId,
      receiveCount: 1,
      code: '23503',
    });
    expect(logged(error)).not.toContain(SECRET);
    expect(await counts()).toEqual({ 'observed/dead_letter': 1 });
  });

  it('TC-209-06 a body that breaks the schema is dead-lettered with a log of the message id and issue codes, never the body', async () => {
    const body = { ...event, amount: SECRET, eventId: SECRET };
    await expect(consumer.handle(body, message(1, 'sqs-msg-9'))).rejects.toBeInstanceOf(
      PoisonMessageError,
    );
    const [fields] = error.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({
      consumer: 'observed',
      outcome: 'dead_letter',
      receiveCount: 1,
      messageId: 'sqs-msg-9',
      reason: 'invalid_event',
    });
    expect(fields.issueCodes).toEqual(expect.arrayContaining(['INVALID_FORMAT']));
    expect(fields).not.toHaveProperty('eventId');
    expect(logged(error)).not.toContain(SECRET);
    expect(await counts()).toEqual({ 'observed/dead_letter': 1 });
  });

  it('TC-209-07 an unknown event type is a dead-letter, or nothing at all when the policy acknowledges it', async () => {
    const unknown = { ...event, eventType: 'SomethingNew' };
    await expect(consumer.handle(unknown, message(1))).rejects.toBeInstanceOf(PoisonMessageError);
    expect(error.mock.calls[0][0]).toMatchObject({ reason: 'unknown_event_type' });
    expect(await counts()).toEqual({ 'observed/dead_letter': 1 });

    error.mockClear();
    consumer.policy = 'acknowledge';
    await consumer.handle(unknown, message(1));
    expect(error).not.toHaveBeenCalled();
    expect(await counts()).toEqual({ 'observed/dead_letter': 1 });
  });

  it('TC-209-08 an event that is applied leaves no log and no count', async () => {
    await consumer.handle(event, message(1));
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(await counts()).toEqual({});
  });

  it('TC-209-09 a label that is not a plain consumer name or outcome is written as unknown', async () => {
    countConsumerMessage('Bad Name/with-data 3f2b8c1e', 'retry');
    countConsumerMessage('risk', 'surprise' as never);
    countConsumerMessage('risk', 'dead_letter');
    expect(await counts()).toEqual({
      'unknown/retry': 1,
      'risk/unknown': 1,
      'risk/dead_letter': 1,
    });
  });
});
