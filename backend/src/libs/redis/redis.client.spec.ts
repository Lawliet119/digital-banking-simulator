import { RedisClient, RedisMetrics } from './index';
import { RedisModule } from './redis.module';
import { redisConfig } from '@config/redis.config';
import { Test } from '@nestjs/testing';
import { register as defaultRegister } from 'prom-client';

const driver = {
  status: 'ready',
  on: jest.fn(),
  disconnect: jest.fn(),
  connect: jest.fn<Promise<void>, []>(),
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
  it('TC-78 startup integration defers module connection and handles connection errors', async () => {
    driver.status = 'wait';
    driver.connect.mockRejectedValueOnce(new Error('unavailable'));
    const deferred = new RedisClient(
      { url: 'redis://localhost:6379', commandTimeoutMs: 50 },
      new RedisMetrics(),
      { lazyConnect: true },
    );
    try {
      expect(construct).toHaveBeenLastCalledWith(
        'redis://localhost:6379',
        expect.objectContaining({ lazyConnect: true }),
      );
      deferred.onModuleInit();
      await Promise.resolve();
      expect(driver.connect).toHaveBeenCalledTimes(1);
    } finally {
      deferred.onModuleDestroy();
    }
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
  /**
   * BL-152: the >=50% listener and opossum itself both read `stats.fires`. opossum emits `fire`
   * before it checks the state, so a call fast-rejected while OPEN also raises `fires` (and
   * `rejects`), but never `failures` or `successes`. These tests drive the real opossum with a caller
   * that keeps retrying while OPEN.
   */
  describe('BL-152 a caller that retries while the breaker is OPEN', () => {
    /** Five successes then five failures: the tenth call is exactly 50% and opens the breaker. */
    async function openAtFiveOfTen(): Promise<void> {
      for (let i = 0; i < 5; i++) await client.get('key');
      driver.get.mockRejectedValue(new Error('down'));
      for (let i = 0; i < 5; i++)
        await expect(client.get('key')).rejects.toMatchObject({ reason: 'COMMAND_FAILED' });
      expect(client.circuitState).toBe('open');
    }
    /** `calls` retries spread over `ms`, every one fast-rejected without touching Redis. */
    async function retryWhileOpen(calls: number, ms: number): Promise<void> {
      const reads = driver.get.mock.calls.length;
      for (let i = 0; i < calls; i++) {
        await expect(client.get('key')).rejects.toMatchObject({ reason: 'CIRCUIT_OPEN' });
        await jest.advanceTimersByTimeAsync(ms / calls);
      }
      expect(driver.get.mock.calls.length).toBe(reads);
    }

    it('TC-76-05c opossum 10.0.0 counts a fast-rejected call in stats.fires (the premise of BL-152)', async () => {
      const CircuitBreaker = (await import('opossum')).default;
      const breaker = new CircuitBreaker(() => Promise.reject(new Error('down')), {
        volumeThreshold: 1,
        resetTimeout: 5000,
      });
      try {
        await expect(breaker.fire()).rejects.toThrow('down');
        expect(breaker.opened).toBe(true);
        const before = breaker.stats;
        await expect(breaker.fire()).rejects.toMatchObject({ code: 'EOPENBREAKER' });
        expect(breaker.stats.fires).toBe(before.fires + 1);
        expect(breaker.stats.rejects).toBe(before.rejects + 1);
        expect(breaker.stats.failures).toBe(before.failures);
      } finally {
        breaker.shutdown();
      }
    });

    it('TC-76-05d retries do not move the half-open time (exactly resetTimeout after it opened)', async () => {
      await openAtFiveOfTen();
      await retryWhileOpen(49, 4900);
      await jest.advanceTimersByTimeAsync(99);
      expect(client.circuitState).toBe('open');
      await jest.advanceTimersByTimeAsync(1);
      expect(client.circuitState).toBe('half-open');
    });

    it('TC-76-05e a failed half-open probe re-opens for another full resetTimeout despite the retries', async () => {
      await openAtFiveOfTen();
      await retryWhileOpen(50, 5000);
      expect(client.circuitState).toBe('half-open');
      await expect(client.get('key')).rejects.toMatchObject({ reason: 'COMMAND_FAILED' });
      expect(client.circuitState).toBe('open');
      await jest.advanceTimersByTimeAsync(4999);
      expect(client.circuitState).toBe('open');
      await jest.advanceTimersByTimeAsync(1);
      expect(client.circuitState).toBe('half-open');
    });

    it('TC-76-05f after recovery the breaker still opens on the same 5/10 rule: the retries are not counted as calls', async () => {
      await openAtFiveOfTen();
      await retryWhileOpen(50, 5000);
      driver.get.mockResolvedValue('restored');
      expect(await client.get('key')).toBe('restored'); // the half-open probe closes the breaker
      expect(client.circuitState).toBe('closed');
      // The window (10 s) still holds the ten calls that opened it, plus the probe: 5 failures in 11
      // calls that ran. One more failure makes 6 of 12 = 50%, exactly the boundary, so it opens now.
      // Were the 49 fast-rejects counted as calls, 6 of 61 would keep it closed for dozens more.
      driver.get.mockRejectedValue(new Error('down again'));
      await expect(client.get('key')).rejects.toMatchObject({ reason: 'COMMAND_FAILED' });
      expect(client.circuitState).toBe('open');
      expect(driver.get).toHaveBeenCalledTimes(12);
    });

    it('TC-76-05g the same boundary holds below it: 4 failures of 12 that ran stay closed after recovery', async () => {
      await openAtFiveOfTen();
      await retryWhileOpen(50, 5000);
      driver.get.mockResolvedValue('restored');
      for (let i = 0; i < 2; i++) expect(await client.get('key')).toBe('restored');
      expect(client.circuitState).toBe('closed');
      // 5 failures in 12 ran (5/12 = 41.7%). A sixth makes 6/13 = 46%: still below the boundary.
      driver.get.mockRejectedValue(new Error('down again'));
      await expect(client.get('key')).rejects.toMatchObject({ reason: 'COMMAND_FAILED' });
      expect(client.circuitState).toBe('closed');
      // The seventh makes 7 of 14 = 50%: open.
      await expect(client.get('key')).rejects.toMatchObject({ reason: 'COMMAND_FAILED' });
      expect(client.circuitState).toBe('open');
    });
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
  it('constructing a second RedisMetrics does not throw on the shared default-registry counter', async () => {
    const before =
      (await defaultRegister.getSingleMetric('redis_fallback_total')?.get())?.values[0]?.value ?? 0;
    expect(() => new RedisMetrics()).not.toThrow();
    const other = new RedisMetrics();
    other.increment();
    const after =
      (await defaultRegister.getSingleMetric('redis_fallback_total')?.get())?.values[0]?.value ?? 0;
    expect(after).toBe(before + 1);
    // other's own isolated counter is unaffected by this instance's increments.
    expect(await other.count()).toBe(1);
    expect(await metrics.count()).toBe(0);
  });
});
