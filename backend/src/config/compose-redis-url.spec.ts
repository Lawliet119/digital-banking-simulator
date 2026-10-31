import { composeRedisUrl } from './compose-redis-url';

const parts = {
  REDIS_HOST: 'master.dbs-dev.abc123.apse1.cache.amazonaws.com',
  REDIS_PORT: '6379',
  REDIS_AUTH_TOKEN: 'Q7rVd2kLm9XwTz4bN8pYh3sJc6fGa1uE',
};

describe('composeRedisUrl (TC-75-08)', () => {
  it('builds a rediss:// url from the parts', () => {
    expect(composeRedisUrl(parts)).toEqual({
      url: 'rediss://:Q7rVd2kLm9XwTz4bN8pYh3sJc6fGa1uE@master.dbs-dev.abc123.apse1.cache.amazonaws.com:6379',
      invalid: [],
    });
  });

  it('encodes special characters so the url parses back to the same token', () => {
    const token = 'p@ss:w/o%rd?#x';
    const { url } = composeRedisUrl({ ...parts, REDIS_AUTH_TOKEN: token });
    const parsed = new URL(url as string);
    expect(parsed.protocol).toBe('rediss:');
    expect(parsed.username).toBe('');
    expect(decodeURIComponent(parsed.password)).toBe(token);
    expect(parsed.hostname).toBe(parts.REDIS_HOST);
    expect(parsed.port).toBe('6379');
  });

  it('never overrides an existing REDIS_URL, but treats an empty one as unset', () => {
    expect(composeRedisUrl({ ...parts, REDIS_URL: 'redis://localhost:6379' })).toEqual({
      invalid: [],
    });
    expect(composeRedisUrl({ ...parts, REDIS_URL: '' }).url).toBeDefined();
  });

  it('does nothing without REDIS_HOST and names the missing parts otherwise', () => {
    expect(composeRedisUrl({})).toEqual({ invalid: [] });
    const { REDIS_PORT: _p, REDIS_AUTH_TOKEN: _t, ...rest } = parts;
    expect(composeRedisUrl(rest)).toEqual({ invalid: ['REDIS_PORT', 'REDIS_AUTH_TOKEN'] });
  });

  it('rejects bad values by name only, never echoing the token', () => {
    const bad = composeRedisUrl({
      REDIS_HOST: 'a/b',
      REDIS_PORT: 'abc',
      REDIS_AUTH_TOKEN: parts.REDIS_AUTH_TOKEN,
    });
    expect(bad.url).toBeUndefined();
    expect(bad.invalid).toEqual(['REDIS_HOST', 'REDIS_PORT']);
    expect(JSON.stringify(bad)).not.toContain(parts.REDIS_AUTH_TOKEN);
    expect(composeRedisUrl({ ...parts, REDIS_PORT: '0' }).invalid).toEqual(['REDIS_PORT']);
    expect(composeRedisUrl({ ...parts, REDIS_PORT: '70000' }).invalid).toEqual(['REDIS_PORT']);
    expect(composeRedisUrl({ ...parts, REDIS_HOST: 'a b' }).invalid).toEqual(['REDIS_HOST']);
    expect(composeRedisUrl({ ...parts, REDIS_AUTH_TOKEN: '' }).invalid).toEqual([
      'REDIS_AUTH_TOKEN',
    ]);
  });
});
