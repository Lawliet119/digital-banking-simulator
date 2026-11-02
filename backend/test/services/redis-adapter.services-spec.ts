import { setTimeout as wait } from 'node:timers/promises';
import { createClient } from 'redis';
import { RedisClient, RedisMetrics, RedisUnavailableError } from '@libs/redis';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';
import { startLatencyProxy } from '../support/latency-proxy';

async function until(condition: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition did not become true');
    await wait(10);
  }
}
describe('DBS-76 Valkey with real slow TCP proxy', () => {
  let valkey: StartedValkey;
  let admin: ReturnType<typeof createClient>;
  let proxy: Awaited<ReturnType<typeof startLatencyProxy>>;
  let client: RedisClient;
  let metrics: RedisMetrics;
  beforeAll(async () => {
    valkey = await startValkeyContainer();
    admin = createClient({ url: valkey.url });
    admin.on('error', () => undefined);
    await admin.connect();
  });
  afterAll(async () => {
    if (admin?.isOpen) admin.destroy();
    await valkey?.stop();
  });
  beforeEach(async () => {
    proxy = await startLatencyProxy(valkey.host, valkey.port);
    metrics = new RedisMetrics();
    client = new RedisClient({ url: proxy.url, commandTimeoutMs: 50 }, metrics);
    await until(() => client.isReady);
  });
  afterEach(async () => {
    client?.onModuleDestroy();
    await proxy?.stop();
  });
  it('TC-76-02 supports expiring cache/counter/sorted set and validates before mutation', async () => {
    expect(await client.get('missing')).toBeNull();
    expect(await client.set('cache', 'safe', 60)).toBe('OK');
    expect(await client.get('cache')).toBe('safe');
    await client.set('counter', '9007199254740992', 60);
    expect(await client.incr('counter', 60)).toBe('9007199254740993');
    expect(await client.zadd('events', 100, 'transfer-id', 60)).toBe(1);
    expect(await client.zadd('events', 100, 'transfer-id', 60)).toBe(0);
    expect(await client.zrangebyscore('events', 0, 100)).toEqual(['transfer-id']);
    for (const key of ['cache', 'counter', 'events'])
      expect(await admin.ttl(key)).toBeGreaterThan(0);
    for (const ttl of [0, 604801, 1e30]) {
      await expect(client.set('cache', 'changed', ttl)).rejects.toThrow(TypeError);
      await expect(client.incr('counter', ttl)).rejects.toThrow(TypeError);
      await expect(client.zadd('absent', 1, 'x', ttl)).rejects.toThrow(TypeError);
    }
    expect(await client.get('cache')).toBe('safe');
    expect(await client.get('counter')).toBe('9007199254740993');
    expect(await admin.exists('absent')).toBe(0);
    expect(await metrics.count()).toBe(0);
    expect(await client.del('cache')).toBe(1);
    expect(await client.ping()).toBe('PONG');
  });
  it('TC-76-03 latency opens breaker at10 failures, skips wire, then recovers', async () => {
    proxy.setDelay(250);
    for (let i = 0; i < 10; i++) {
      const started = Date.now();
      await expect(client.ping()).rejects.toMatchObject({ reason: 'TIMEOUT' });
      expect(Date.now() - started).toBeLessThan(1000);
      if (i < 9) expect(client.circuitState).toBe('closed');
    }
    expect(client.circuitState).toBe('open');
    expect(await metrics.count()).toBe(10);
    const bytes = proxy.requestBytes;
    await expect(client.ping()).rejects.toMatchObject({ reason: 'CIRCUIT_OPEN' });
    expect(proxy.requestBytes).toBe(bytes);
    expect(await metrics.count()).toBe(11);
    proxy.setDelay(0);
    await until(() => client.circuitState === 'half-open', 6500);
    expect(await client.ping()).toBe('PONG');
    expect(client.circuitState).toBe('closed');
  });
  it('TC-76-04 stopped Valkey rejects explicitly with a fallback metric', async () => {
    await valkey.stop();
    await until(() => !client.isReady);
    await expect(client.get('cache')).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(await metrics.count()).toBe(1);
  });
});
