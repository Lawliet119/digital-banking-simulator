import { activeTransactionContext } from '@database/transaction.helper';
import type { RedisClient } from '@libs/redis';
import { SessionRevocationCache } from './session-revocation-cache';

describe('DBS-114 revocation cache contract', () => {
  const USER = 'f2d3c4b5-1234-4567-8910-123456789012';
  const epoch = 1_700_000_000;
  function fixture(value: string | null = String(epoch), ttl = 900) {
    const redis = {
      get: jest.fn().mockResolvedValue(value),
      set: jest.fn().mockResolvedValue('OK'),
    };
    return {
      redis,
      cache: new SessionRevocationCache(
        redis as unknown as RedisClient,
        { accessTokenTtlSeconds: ttl } as never,
      ),
    };
  }
  it('TC-114-09 reads canonical epoch SECONDS, not milliseconds or a session object', async () => {
    const { cache, redis } = fixture();
    expect(await cache.read(USER)).toEqual(new Date(epoch * 1000));
    expect(redis.get).toHaveBeenCalledWith(`revoked_at:${USER}`);
  });
  it.each([
    null,
    '',
    'null',
    'NaN',
    'Infinity',
    '-1',
    '0',
    '01',
    '1.5',
    '1e9',
    '1700000000000',
    '253402300800',
    '{}',
    ' 1700000000',
  ])('TC-114-09 treats malformed or absent %s as a cache miss', async value => {
    expect(await fixture(value).cache.read(USER)).toBeUndefined();
  });
  it('TC-114-09 unavailable read is a miss; unavailable publish does not change the SQL result', async () => {
    const { cache, redis } = fixture();
    redis.get.mockRejectedValue(new Error('unavailable'));
    redis.set.mockRejectedValue(new Error('unavailable'));
    expect(await cache.read(USER)).toBeUndefined();
    await expect(cache.publish(USER, new Date(epoch * 1000))).resolves.toBeUndefined();
  });
  it.each([60, 900, 86400])(
    'TC-114-09 publishes positive marker with configured TTL %s',
    async ttl => {
      const { cache, redis } = fixture(null, ttl);
      await cache.publish(USER, new Date(epoch * 1000 + 999));
      expect(redis.set).toHaveBeenCalledWith(`revoked_at:${USER}`, String(epoch), ttl);
    },
  );
  it('TC-114-09 cannot publish inside a transaction callback', async () => {
    const { cache, redis } = fixture();
    await expect(
      activeTransactionContext.run(true, () => cache.publish(USER, new Date(epoch * 1000))),
    ).rejects.toThrow(TypeError);
    expect(redis.set).not.toHaveBeenCalled();
  });
});
