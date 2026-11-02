import { SQSClient as AwsClient } from '@aws-sdk/client-sqs';
import { SqsClient } from './sqs.client';
import { Test } from '@nestjs/testing';
import { sqsConfig } from '@config/sqs.config';
import { SqsModule } from './sqs.module';

const send = jest.fn<Promise<unknown>, [unknown]>();
const destroy = jest.fn();
jest.mock('@aws-sdk/client-sqs', () => ({
  ...jest.requireActual<typeof import('@aws-sdk/client-sqs')>('@aws-sdk/client-sqs'),
  SQSClient: jest.fn().mockImplementation(() => ({ send, destroy })),
}));

describe('DBS-77 SQS transport', () => {
  let client: SqsClient;
  beforeEach(() => {
    send.mockReset();
    destroy.mockClear();
    client = new SqsClient({ region: 'ap-southeast-1', endpoint: 'http://localhost:9324' });
  });
  it('TC-77-01 sends String attributes and requests long polling batch with receipt metadata', async () => {
    send.mockResolvedValue({ Messages: [] });
    await client.send('queue', '{}', { correlationId: 'server-id' });
    expect(send.mock.calls[0][0]).toMatchObject({
      input: {
        QueueUrl: 'queue',
        MessageBody: '{}',
        MessageAttributes: { correlationId: { DataType: 'String', StringValue: 'server-id' } },
      },
    });
    expect(await client.receive('queue')).toEqual([]);
    expect(send.mock.calls[1][0]).toMatchObject({
      input: {
        QueueUrl: 'queue',
        WaitTimeSeconds: 20,
        MaxNumberOfMessages: 10,
        VisibilityTimeout: 30,
        MessageAttributeNames: ['All'],
      },
    });
    expect(AwsClient).toHaveBeenCalledWith({
      region: 'ap-southeast-1',
      endpoint: 'http://localhost:9324',
    });
    client.onModuleDestroy();
    expect(destroy).toHaveBeenCalled();
  });
  it('TC-77-01 refuses invalid receive options before sending', async () => {
    for (const opts of [
      { waitTimeSeconds: 21 },
      { waitTimeSeconds: -1 },
      { maxMessages: 0 },
      { maxMessages: 11 },
      { visibilityTimeout: 43201 },
      { visibilityTimeout: 1.5 },
    ]) {
      await expect(client.receive('queue', opts)).rejects.toThrow(RangeError);
    }
    expect(send).not.toHaveBeenCalled();
  });
  it('TC-77-01 exports an injectable client and closes the SDK with the module', async () => {
    const module = await Test.createTestingModule({ imports: [SqsModule] })
      .overrideProvider(sqsConfig.KEY)
      .useValue({ region: 'ap-southeast-1' })
      .compile();
    expect(module.get(SqsClient)).toBeInstanceOf(SqsClient);
    await module.close();
    expect(destroy).toHaveBeenCalled();
  });
  it('TC-77-04 preserves source when DLQ forwarding fails', async () => {
    send
      .mockResolvedValueOnce({
        Messages: [{ MessageId: 'bad', Body: '{', ReceiptHandle: 'receipt' }],
      })
      .mockRejectedValueOnce(new Error('down'));
    expect(
      await client.processBatch('source', 'dlq', () => Promise.resolve(), { waitTimeSeconds: 0 }),
    ).toEqual([{ messageId: 'bad', status: 'failed' }]);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('TC-77-05 propagates transport errors and reports delete failure', async () => {
    send.mockRejectedValueOnce(new Error('unavailable'));
    await expect(client.receive('queue')).rejects.toThrow('unavailable');
    send.mockRejectedValueOnce(new Error('unavailable'));
    await expect(client.send('queue', '{}')).rejects.toThrow('unavailable');
    send
      .mockResolvedValueOnce({
        Messages: [{ MessageId: 'ok', Body: '{}', ReceiptHandle: 'receipt' }],
      })
      .mockRejectedValueOnce(new Error('delete failed'));
    expect(await client.processBatch('queue', 'dlq', () => Promise.resolve())).toEqual([
      { messageId: 'ok', status: 'failed' },
    ]);
    send.mockResolvedValueOnce({});
    expect(await client.processBatch('queue', 'dlq', () => Promise.resolve())).toEqual([]);
  });
});
