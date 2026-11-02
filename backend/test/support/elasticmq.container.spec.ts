import type { StartedTestContainer } from 'testcontainers';

const mockSend = jest.fn();
const mockDestroy = jest.fn();
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSend, destroy: mockDestroy })),
  GetQueueUrlCommand: jest.fn((input: Record<string, unknown>) => ({
    __command: 'GetQueueUrl',
    ...input,
  })),
}));

const GenericContainerMock = jest.fn();
jest.mock('testcontainers', () => {
  const actual = jest.requireActual<typeof import('testcontainers')>('testcontainers');
  return { ...actual, GenericContainer: GenericContainerMock };
});

const assertDockerAvailableMock = jest.fn();
jest.mock('./postgres.container', () => {
  const actual = jest.requireActual<typeof import('./postgres.container')>('./postgres.container');
  return { ...actual, assertDockerAvailable: assertDockerAvailableMock };
});

import {
  ELASTICMQ_PROBE_TIMEOUT_MS,
  probeRiskQueue,
  startElasticMqContainer,
} from './elasticmq.container';

describe('probeRiskQueue (TC-40-08, DBS-40 vòng 2)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockDestroy.mockReset();
  });

  it('trả riskQueuePath qua giá trị trả về, không qua biến side-effect + non-null assertion', async () => {
    mockSend.mockResolvedValueOnce({
      QueueUrl: 'http://localhost:9324/000000000000/risk-events',
    });
    const started = {
      getHost: () => '127.0.0.1',
      getMappedPort: () => 32768,
    } as unknown as StartedTestContainer;

    const riskQueuePath = await probeRiskQueue(started, new AbortController().signal);

    expect(riskQueuePath).toBe('/000000000000/risk-events');
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('ELASTICMQ_PROBE_TIMEOUT_MS = 150s (biên ~15,6% so với ngân sách retry ~129,75s)', () => {
    expect(ELASTICMQ_PROBE_TIMEOUT_MS).toBe(150_000);
  });
});

describe('startElasticMqContainer Docker-down short-circuit (TC-40-09, DBS-40 vòng 2)', () => {
  beforeEach(() => {
    assertDockerAvailableMock.mockReset();
    GenericContainerMock.mockClear();
    mockSend.mockClear();
  });

  it('không tạo GenericContainer hoặc gọi SQS khi Docker không có sẵn', async () => {
    assertDockerAvailableMock.mockRejectedValue(
      new Error('[Testcontainers] Docker is not running or unreachable.'),
    );

    await expect(startElasticMqContainer()).rejects.toThrow('Docker is not running');

    expect(GenericContainerMock).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
