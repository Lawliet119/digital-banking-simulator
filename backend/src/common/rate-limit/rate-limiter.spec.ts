import { RedisUnavailableError, type RedisClient, type RedisFailureReason } from '@libs/redis';
import { Clock } from '@common/clock';
import { clientIp } from './client-ip';
import { RateLimitMetrics } from './rate-limit.metrics';
import { RateLimiter } from './rate-limiter';

class FakeClock extends Clock {
  constructor(public at: number) {
    super();
  }
  now(): Date {
    return new Date(this.at);
  }
}
/** The Redis the limiter sees: INCR with an EXPIRE, like RedisClient.incr. */
class FakeRedis {
  counts = new Map<string, number>();
  ttls = new Map<string, number>();
  failWith: unknown;
  calls = 0;
  incr(key: string, ttl: number): Promise<string> {
    this.calls += 1;
    // Rejecting with something that is not an Error is the point of one of the tests.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if (this.failWith) return Promise.reject(this.failWith);
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    this.ttls.set(key, ttl);
    return Promise.resolve(String(next));
  }
}
const MINUTE = Date.UTC(2026, 2, 15, 10, 30, 0); // 15 Mar 2026 10:30:00.000Z

function setup(at = MINUTE) {
  const redis = new FakeRedis();
  const clock = new FakeClock(at);
  const metrics = new RateLimitMetrics();
  const limiter = new RateLimiter(redis as unknown as RedisClient, clock, metrics);
  return { redis, clock, metrics, limiter };
}

describe('TC-89-01 RateLimiter counts per scope, id and minute', () => {
  it('lets `limit` requests through and stops the next one', async () => {
    const { limiter } = setup();
    for (let i = 1; i <= 3; i++) {
      expect(await limiter.hit('ip', '203.0.113.7', 3)).toMatchObject({ allowed: true });
    }
    expect(await limiter.hit('ip', '203.0.113.7', 3)).toMatchObject({ allowed: false });
    expect(await limiter.hit('ip', '203.0.113.7', 3)).toMatchObject({ allowed: false });
  });

  it('keeps ids and scopes apart and starts again in the next minute', async () => {
    const { limiter, clock, redis } = setup();
    expect((await limiter.hit('ip', 'a', 1)).allowed).toBe(true);
    expect((await limiter.hit('ip', 'a', 1)).allowed).toBe(false);
    expect((await limiter.hit('ip', 'b', 1)).allowed).toBe(true); // another id
    expect((await limiter.hit('user', 'a', 1)).allowed).toBe(true); // another scope
    clock.at += 60_000;
    expect((await limiter.hit('ip', 'a', 1)).allowed).toBe(true); // next minute
    expect([...redis.counts.keys()].sort()).toEqual(
      [
        `rl:ip:a:${MINUTE / 60_000}`,
        `rl:ip:a:${MINUTE / 60_000 + 1}`,
        `rl:ip:b:${MINUTE / 60_000}`,
        `rl:user:a:${MINUTE / 60_000}`,
      ].sort(),
    );
  });

  it('expires every counter after 60 seconds so Redis never keeps them', async () => {
    const { limiter, redis } = setup();
    await limiter.hit('user', 'u', 10);
    expect([...redis.ttls.values()]).toEqual([60]);
  });

  it('counts a request that was refused too, so a sustained flood stays refused', async () => {
    const { limiter, redis } = setup();
    for (let i = 0; i < 5; i++) await limiter.hit('ip', 'x', 2);
    expect([...redis.counts.values()]).toEqual([5]);
  });

  it('counts the requests of one minute even when they are not evenly spread', async () => {
    const { limiter, clock } = setup(MINUTE + 5_000);
    expect((await limiter.hit('user', 'u', 2)).allowed).toBe(true);
    clock.at = MINUTE + 59_000; // 54 seconds later, same minute
    expect((await limiter.hit('user', 'u', 2)).allowed).toBe(true);
    expect((await limiter.hit('user', 'u', 2)).allowed).toBe(false);
  });
});

describe('TC-89-02 Retry-After is the time left in the minute', () => {
  it.each([
    [MINUTE, 60],
    [MINUTE + 23_400, 37],
    [MINUTE + 59_900, 1],
    [MINUTE + 59_000, 1],
    [MINUTE + 1, 60],
    [MINUTE + 30_000, 30],
  ])('at +%d ms of the minute: %d s', async (at, seconds) => {
    const { limiter } = setup(at);
    await limiter.hit('ip', 'z', 1);
    expect(await limiter.hit('ip', 'z', 1)).toEqual({ allowed: false, retryAfterSeconds: seconds });
  });

  it('is always between 1 and 60', async () => {
    for (let offset = 0; offset < 60_000; offset += 997) {
      const { limiter } = setup(MINUTE + offset);
      await limiter.hit('ip', 'z', 1);
      const { retryAfterSeconds } = await limiter.hit('ip', 'z', 1);
      expect(retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });
});

describe('TC-89-03 RateLimiter fails open', () => {
  const reasons: RedisFailureReason[] = [
    'TIMEOUT',
    'CIRCUIT_OPEN',
    'UNAVAILABLE',
    'COMMAND_FAILED',
    'SHUTDOWN',
  ];
  it.each(reasons)('lets the request through when Redis says %s', async reason => {
    const { limiter, redis } = setup();
    redis.failWith = new RedisUnavailableError(reason);
    expect(await limiter.hit('ip', '198.51.100.9', 1)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect(await limiter.hit('ip', '198.51.100.9', 1)).toMatchObject({ allowed: true });
  });

  it('lets the request through on an error nobody expected, and never throws', async () => {
    const { limiter, redis } = setup();
    redis.failWith = new TypeError('something else broke');
    await expect(limiter.hit('user', 'u', 1)).resolves.toMatchObject({ allowed: true });
    redis.failWith = 'not even an Error';
    await expect(limiter.hit('user', 'u', 1)).resolves.toMatchObject({ allowed: true });
  });

  it('logs the reason only: never a key, an IP or a user id', async () => {
    const { limiter, redis } = setup();
    const lines: string[] = [];
    const logger = (limiter as unknown as { logger: { warn: (m: string) => void } }).logger;
    jest.spyOn(logger, 'warn').mockImplementation((message: string) => void lines.push(message));
    redis.failWith = new RedisUnavailableError('TIMEOUT');
    await limiter.hit('ip', '198.51.100.9', 1);
    await limiter.hit('user', '5b2f0e0a-1111-4222-8333-444455556666', 1);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain('TIMEOUT');
      expect(line).not.toMatch(/198\.51|5b2f0e0a|rl:/);
    }
  });

  it('counts a refusal in rate_limited_total and a pass-through not at all', async () => {
    const { limiter, redis, metrics } = setup();
    await limiter.hit('ip', 'm', 1);
    expect(await metrics.count('ip')).toBe(0);
    await limiter.hit('ip', 'm', 1);
    await limiter.hit('user', 'm', 0);
    expect(await metrics.count('ip')).toBe(1);
    expect(await metrics.count('user')).toBe(1);
    redis.failWith = new RedisUnavailableError('TIMEOUT');
    await limiter.hit('ip', 'n', 0);
    expect(await metrics.count('ip')).toBe(1); // a fail-open pass is not a refusal
  });
});

describe('TC-89-04 clientIp', () => {
  const request = (ip: string | undefined, remote?: string) =>
    ({ ip, socket: { remoteAddress: remote } }) as never;
  it('uses what Express worked out, minus the IPv4-mapped prefix', () => {
    expect(clientIp(request('203.0.113.7'))).toBe('203.0.113.7');
    expect(clientIp(request('::ffff:203.0.113.7'))).toBe('203.0.113.7');
    expect(clientIp(request('2001:db8::1'))).toBe('2001:db8::1');
  });
  it('falls back to the socket and then to a fixed marker, never to undefined', () => {
    expect(clientIp(request(undefined, '::ffff:192.0.2.1'))).toBe('192.0.2.1');
    expect(clientIp(request(undefined, undefined))).toBe('unknown');
    expect(clientIp(request('', ''))).toBe('unknown');
  });
});
