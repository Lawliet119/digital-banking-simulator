import { RedisClient, RedisMetrics } from './index';
import { RedisModule } from './redis.module';
import { redisConfig } from '@config/redis.config';
import { Test } from '@nestjs/testing';

const driver = {
  status: 'ready',
  on: jest.fn(),
  disconnect: jest.fn(),
  get: jest.fn<Promise<string | null>, [string]>(),
  set: jest.fn(),
  eval: jest.fn(),
  zrangebyscore: jest.fn(),
  del: jest.fn(),
  ping: jest.fn(),
};
const construct = jest.fn((_url: string, _options: unknown) => driver);
jest.mock('ioredis', () => ({
  __esModule: true,
  default: function (url: string, options: unknown) {
    return construct(url, options);
  },
}));

describe('DBS-76 Redis policy', () => {
  let client: RedisClient;
  let metrics: RedisMetrics;
  beforeEach(() => {
    jest.useFakeTimers();
    driver.status = 'ready';
    driver.get.mockReset().mockResolvedValue('cached');
    construct.mockClear();
    metrics = new RedisMetrics();
    client = new RedisClient({ url: 'redis://localhost:6379', commandTimeoutMs: 1000 }, metrics);
  });
  afterEach(() => {
    client.onModuleDestroy();
    jest.useRealTimers();
  });
  it('TC-76-01 exports client/metrics through Nest module and closes cleanly', async () => {
    const module = await Test.createTestingModule({ imports: [RedisModule] })
      .overrideProvider(redisConfig.KEY)
      .useValue({ url: 'rediss://localhost:6379', commandTimeoutMs: 50 })
      .compile();
    const exported = module.get(RedisClient);
    expect(exported).toBeInstanceOf(RedisClient);
    expect(module.get(RedisMetrics)).toBeInstanceOf(RedisMetrics);
    await module.close();
    expect(exported.circuitState).toBe('shutdown');
    expect(construct).toHaveBeenLastCalledWith(
      'rediss://localhost:6379',
      expect.not.objectContaining({ tls: { rejectUnauthorized: false } }),
    );
  });
  it('TC-76-01 caps command deadline and disables queues/replay', () => {
    expect(construct).toHaveBeenCalledWith(
      'redis://localhost:6379',
      expect.objectContaining({
        commandTimeout: 50,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        maxRetriesPerRequest: 0,
      }),
    );
  });
  it('TC-76-01/05 rejects at50ms with one fallback and redacted error', async () => {
    driver.get.mockImplementation(() => new Promise(() => undefined));
    const result = expect(client.get('private-key')).rejects.toMatchObject({
      reason: 'TIMEOUT',
      message: 'Redis fallback required: TIMEOUT',
    });
    await jest.advanceTimersByTimeAsync(50);
    await result;
    expect(await metrics.count()).toBe(1);
    expect(await metrics.metrics()).toContain('redis_fallback_total 1');
  });
  it('TC-76-05 opens at exactly5 failures of10 then recovers after5seconds', async () => {
    for (let i = 0; i < 5; i++) await client.get('key');
    driver.get.mockRejectedValue(new Error('secret-url and private-key'));
    for (let i = 0; i < 5; i++)
      await expect(client.get('key')).rejects.toMatchObject({ reason: 'COMMAND_FAILED' });
    expect(client.circuitState).toBe('open');
    await expect(client.get('key')).rejects.toMatchObject({ reason: 'CIRCUIT_OPEN' });
    expect(driver.get).toHaveBeenCalledTimes(10);
    expect(await metrics.count()).toBe(6);
    await jest.advanceTimersByTimeAsync(5000);
    expect(client.circuitState).toBe('half-open');
    driver.get.mockResolvedValue('restored');
    expect(await client.get('key')).toBe('restored');
    expect(client.circuitState).toBe('closed');
  });
  it('TC-76-05 four failures of10 stay closed and aged failures roll out', async () => {
    driver.get.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 4; i++)
      await expect(client.get('key')).rejects.toMatchObject({ reason: 'COMMAND_FAILED' });
    driver.get.mockResolvedValue('ok');
    for (let i = 0; i < 6; i++) await client.get('key');
    expect(client.circuitState).toBe('closed');
    await jest.advanceTimersByTimeAsync(11000);
    driver.get.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 9; i++)
      await expect(client.get('key')).rejects.toMatchObject({ reason: 'COMMAND_FAILED' });
    expect(client.circuitState).toBe('closed');
    await expect(client.get('key')).rejects.toMatchObject({ reason: 'COMMAND_FAILED' });
    expect(client.circuitState).toBe('open');
  });
  it('TC-76-01 invalidTTL never calls Redis or counts fallback; unavailable is explicit', async () => {
    for (const ttl of [0, -1, 1.5, 604801, 1e30]) {
      await expect(client.set('key', 'v', ttl)).rejects.toThrow(TypeError);
      await expect(client.incr('key', ttl)).rejects.toThrow(TypeError);
      await expect(client.zadd('key', 1, 'id', ttl)).rejects.toThrow(TypeError);
    }
    expect(driver.eval).not.toHaveBeenCalled();
    expect(driver.set).not.toHaveBeenCalled();
    expect(await metrics.count()).toBe(0);
    driver.status = 'reconnecting';
    await expect(client.get('key')).rejects.toMatchObject({ reason: 'UNAVAILABLE' });
    expect(await metrics.count()).toBe(1);
    client.onModuleDestroy();
    await expect(client.get('key')).rejects.toMatchObject({ reason: 'SHUTDOWN' });
    expect(driver.disconnect).toHaveBeenCalled();
  });
});
