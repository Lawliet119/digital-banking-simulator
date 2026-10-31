const createClientMock = jest.fn();
jest.mock('redis', () => ({ createClient: createClientMock }));

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

import type { StartedTestContainer } from 'testcontainers';
import { probeValkey, startValkeyContainer, VALKEY_PROBE_TIMEOUT_MS } from './valkey.container';

// Giả lập hành vi thật của node-redis với reconnectStrategy:false: connect() lỗi thì client đóng
// (isOpen=false) và destroy() trên client đã đóng ném ClientClosedError ('The client is closed').
function fakeClient(connectError?: Error) {
  const client = {
    isOpen: false,
    on: jest.fn(),
    connect: jest.fn(() => {
      if (connectError) return Promise.reject(connectError);
      client.isOpen = true;
      return Promise.resolve();
    }),
    ping: jest.fn().mockResolvedValue('PONG'),
    destroy: jest.fn(() => {
      if (!client.isOpen) throw new Error('The client is closed');
      client.isOpen = false;
    }),
  };
  return client;
}

const started = {
  getHost: () => '127.0.0.1',
  getMappedPort: () => 32768,
} as unknown as StartedTestContainer;

describe('probeValkey (TC-40-13, DBS-40 vòng 2 — retry khi Docker chưa nối xong cổng)', () => {
  beforeEach(() => {
    createClientMock.mockReset();
  });

  it('thử lại khi connect bị từ chối rồi thành công, không ném ClientClosedError khi dọn client lỗi', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const first = fakeClient(refused);
    const second = fakeClient(refused);
    const third = fakeClient();
    createClientMock
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third);

    await expect(probeValkey(started, new AbortController().signal)).resolves.toBeUndefined();

    expect(createClientMock).toHaveBeenCalledTimes(3);
    expect(first.destroy).not.toHaveBeenCalled();
    expect(second.destroy).not.toHaveBeenCalled();
    expect(third.destroy).toHaveBeenCalledTimes(1);
    expect(third.ping).toHaveBeenCalledTimes(1);
  });

  it('đăng ký listener "error" để lỗi kết nối không thoát ra ngoài probe', async () => {
    const client = fakeClient();
    createClientMock.mockReturnValueOnce(client);

    await probeValkey(started, new AbortController().signal);

    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('hết số lần thử thì ném đúng lỗi kết nối cuối cùng, không phải ClientClosedError', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    createClientMock.mockImplementation(() => fakeClient(refused));

    await expect(probeValkey(started, new AbortController().signal, 3)).rejects.toThrow(
      'connect ECONNREFUSED',
    );
    expect(createClientMock).toHaveBeenCalledTimes(3);
  });

  it('dừng thử lại ngay khi signal đã abort (outer timeout đã bắn)', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(probeValkey(started, controller.signal)).rejects.toThrow(/aborted/);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('PING trả khác PONG thì ném lỗi rõ ràng và vẫn dọn client đang mở', async () => {
    const client = fakeClient();
    client.ping.mockResolvedValue('NOPE');
    createClientMock.mockReturnValue(client);

    // attempts=1: PING sai cũng nằm trong vòng retry, nên chỉ một lần thử mới tách được đường dọn.
    await expect(probeValkey(started, new AbortController().signal, 1)).rejects.toThrow(
      'Valkey PING failed',
    );
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('VALKEY_PROBE_TIMEOUT_MS = 45s (ngân sách retry 10×3000 + 9×250 = 32,25s, biên ~39%)', () => {
    const retryBudgetMs = 10 * 3_000 + 9 * 250;
    expect(retryBudgetMs).toBe(32_250);
    expect(VALKEY_PROBE_TIMEOUT_MS).toBe(45_000);
    expect(VALKEY_PROBE_TIMEOUT_MS).toBeGreaterThan(retryBudgetMs * 1.3);
  });
});

describe('startValkeyContainer Docker-down short-circuit (TC-40-09, DBS-40 vòng 2)', () => {
  beforeEach(() => {
    assertDockerAvailableMock.mockReset();
    GenericContainerMock.mockClear();
    createClientMock.mockClear();
  });

  it('không tạo GenericContainer hoặc Redis client khi Docker không có sẵn', async () => {
    assertDockerAvailableMock.mockRejectedValue(
      new Error('[Testcontainers] Docker is not running or unreachable.'),
    );

    await expect(startValkeyContainer()).rejects.toThrow('Docker is not running');

    expect(GenericContainerMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });
});
