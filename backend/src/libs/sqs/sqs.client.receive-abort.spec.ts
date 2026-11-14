import { SqsClient } from './sqs.client';

const send = jest.fn<Promise<unknown>, [unknown, unknown?]>();
jest.mock('@aws-sdk/client-sqs', () => ({
  ...jest.requireActual<typeof import('@aws-sdk/client-sqs')>('@aws-sdk/client-sqs'),
  SQSClient: jest.fn().mockImplementation(() => ({ send, destroy: jest.fn() })),
}));

describe('BL-209 SqsClient.receive can be cancelled', () => {
  let client: SqsClient;
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({ Messages: [] });
    client = new SqsClient({ region: 'ap-southeast-1', endpoint: 'http://localhost:9324' });
  });

  it('TC-209-13 passes the abort signal to the SDK, and passes nothing when there is none', async () => {
    await client.receive('queue');
    expect(send.mock.calls[0][1]).toBeUndefined();
    const controller = new AbortController();
    await client.receive('queue', { abortSignal: controller.signal });
    expect(send.mock.calls[1][1]).toEqual({ abortSignal: controller.signal });
  });

  it('TC-209-14 the abort signal does not touch the validated receive options', async () => {
    const controller = new AbortController();
    await expect(
      client.receive('queue', { waitTimeSeconds: 21, abortSignal: controller.signal }),
    ).rejects.toThrow(RangeError);
    expect(send).not.toHaveBeenCalled();
  });

  it('TC-209-15 processBatch hands the signal to receive and lets the abort error out', async () => {
    const controller = new AbortController();
    send.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(
      client.processBatch('queue', 'queue-dlq', () => Promise.resolve(), {
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(send.mock.calls[0][1]).toEqual({ abortSignal: controller.signal });
  });
});
