import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { redisConfig } from '@config/redis.config';
import Redis from 'ioredis';
import CircuitBreaker from 'opossum';
import { RedisMetrics } from './redis.metrics';

export type RedisFailureReason =
  'TIMEOUT' | 'CIRCUIT_OPEN' | 'UNAVAILABLE' | 'COMMAND_FAILED' | 'SHUTDOWN' | 'CORRUPT';
export class RedisUnavailableError extends Error {
  constructor(readonly reason: RedisFailureReason) {
    super(`Redis fallback required: ${reason}`);
    this.name = 'RedisUnavailableError';
  }
}
const INCR =
  "redis.call('INCR',KEYS[1]); redis.call('EXPIRE',KEYS[1],ARGV[1]); return redis.call('GET',KEYS[1])";
const ZADD =
  "local n=redis.call('ZADD',KEYS[1],ARGV[1],ARGV[2]); redis.call('EXPIRE',KEYS[1],ARGV[3]); return n";

const MAX_CACHE_TIME_MS = 253_402_300_799_999;
const VERSION_CACHE_LUA = `
local function now_ms()
  local time = redis.call('TIME')
  return tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
end
-- nil: no usable marker because the key is absent or its deadline has passed (a normal miss).
-- false: the key exists but is not a marker this code wrote (wrong type, junk, out of range).
local function valid(key, now)
  local kind = redis.call('TYPE', key).ok
  if kind == 'none' then return nil end
  if kind ~= 'string' then return false end
  local ttl = redis.call('PTTL', key)
  if ttl == -2 then return nil end
  if ttl <= 0 or ttl > 60000 then return false end
  local value = redis.call('GET', key)
  local version, deadline = string.match(value, '^([1-9]%d*):([1-9]%d*)$')
  if not version or #version > 10 or #deadline > 15 then return false end
  local nversion, ndeadline = tonumber(version), tonumber(deadline)
  if nversion > 2147483647 or ndeadline > 253402300799999 then return false end
  if ndeadline <= now then return nil end
  if ndeadline - now > 60000 or ttl > ndeadline - now + 1 then return false end
  return {version, deadline}
end
`;
const READ_VERSION = `${VERSION_CACHE_LUA}
local result = valid(KEYS[1], now_ms())
if result == false then return {'corrupt'} end
if result then return result end
return nil
`;
const SET_VERSION = `${VERSION_CACHE_LUA}
local now = now_ms()
local deadline = tonumber(ARGV[2])
if deadline <= now or deadline - now > 60000 then return 0 end
local old = valid(KEYS[1], now)
if old and tonumber(old[1]) > tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1] .. ':' .. ARGV[2], 'PXAT', ARGV[2])
return 1
`;

export interface ExpiringVersion {
  readonly version: number;
  readonly deadlineMs: number;
}

const REDIS_CLIENT_OPTIONS = Symbol('REDIS_CLIENT_OPTIONS');

@Injectable()
export class RedisClient implements OnModuleDestroy, OnModuleInit {
  private readonly driver: Redis;
  private readonly breaker: CircuitBreaker<[() => Promise<unknown>], unknown>;
  private disposed = false;
  constructor(
    @Inject(redisConfig.KEY) config: ConfigType<typeof redisConfig>,
    private readonly metrics: RedisMetrics,
    @Optional() @Inject(REDIS_CLIENT_OPTIONS) options?: { lazyConnect?: boolean },
  ) {
    if (!Number.isInteger(config.commandTimeoutMs) || config.commandTimeoutMs < 10)
      throw new TypeError('Invalid Redis command timeout');
    const timeout = Math.min(config.commandTimeoutMs, 50);
    this.driver = new Redis(config.url, {
      lazyConnect: options?.lazyConnect ?? false,
      commandTimeout: timeout,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1000,
      // Shutdown discards pending cache operations; don't retain ioredis's 2s force-close timer.
      disconnectTimeout: 0,
      retryStrategy: () => 1000,
    });
    // Operational errors are mapped per command; never log keys, URLs, credentials or values.
    this.driver.on('error', () => undefined);
    this.breaker = new CircuitBreaker(
      (operation: () => Promise<unknown>) => {
        if (this.driver.status !== 'ready')
          return Promise.reject(new RedisUnavailableError('UNAVAILABLE'));
        return operation();
      },
      {
        timeout,
        errorThresholdPercentage: 50,
        volumeThreshold: 10,
        rollingCountTimeout: 10000,
        rollingCountBuckets: 10,
        resetTimeout: 5000,
      },
    );
    // Opossum uses strict >50. ADR-12 requires >=50 at a failure; retain configured50
    // and close the exact-boundary gap using the same rolling statistics.
    this.breaker.on('failure', () => {
      const stats = this.breaker.stats;
      if (this.breaker.closed && stats.fires >= 10 && stats.failures * 100 >= stats.fires * 50)
        this.breaker.open();
    });
  }
  get isReady(): boolean {
    return !this.disposed && this.driver.status === 'ready';
  }
  onModuleInit(): void {
    // NestFactory.create can fail before returning a context to main's cleanup.
    // A module-owned client must not open reconnect sockets until app.init starts.
    if (!this.disposed && this.driver.status === 'wait')
      void this.driver.connect().catch(() => undefined);
  }
  get circuitState(): 'closed' | 'open' | 'half-open' | 'shutdown' {
    return this.disposed
      ? 'shutdown'
      : this.breaker.opened
        ? 'open'
        : this.breaker.halfOpen
          ? 'half-open'
          : 'closed';
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      if (this.disposed) throw new RedisUnavailableError('SHUTDOWN');
      return (await this.breaker.fire(operation)) as T;
    } catch (error) {
      this.metrics.increment();
      if (this.disposed) throw new RedisUnavailableError('SHUTDOWN');
      if (error instanceof RedisUnavailableError) throw error;
      const code = (error as { code?: string } | null)?.code;
      const message = error instanceof Error ? error.message : '';
      const reason: RedisFailureReason =
        code === 'EOPENBREAKER'
          ? 'CIRCUIT_OPEN'
          : code === 'ETIMEDOUT' || message === 'Command timed out'
            ? 'TIMEOUT'
            : this.driver.status !== 'ready'
              ? 'UNAVAILABLE'
              : 'COMMAND_FAILED';
      throw new RedisUnavailableError(reason);
    }
  }
  private ttl(seconds: number): void {
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 604800)
      throw new TypeError('Redis TTL must be an integer from 1 to 604800 seconds');
  }
  get(key: string): Promise<string | null> {
    return this.run(() => this.driver.get(key));
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<string> {
    this.ttl(ttlSeconds);
    return this.run(() => this.driver.set(key, value, 'EX', ttlSeconds));
  }

  /** Redis server time bounds publication independently of application clock skew. */
  serverTimeMs(): Promise<number> {
    return this.run(async () => {
      const [seconds, micros] = await this.driver.time();
      const time = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
      if (!Number.isSafeInteger(time) || time < 0 || time > MAX_CACHE_TIME_MS) {
        throw new Error('Invalid Redis server time');
      }
      return time;
    });
  }
  async readExpiringVersion(key: string): Promise<ExpiringVersion | null> {
    const result = await this.run(
      () => this.driver.eval(READ_VERSION, 1, key) as Promise<string[] | null>,
    );
    if (result === null) return null;
    // Redis answered, but with a value this code never wrote: not an outage, so not a breaker hit.
    if (result.length === 1 && result[0] === 'corrupt') throw new RedisUnavailableError('CORRUPT');
    const version = Number(result[0]);
    const deadlineMs = Number(result[1]);
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > 2_147_483_647 ||
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > MAX_CACHE_TIME_MS
    ) {
      throw new RedisUnavailableError('CORRUPT');
    }
    return { version, deadlineMs };
  }
  async setVersionBefore(key: string, version: number, deadlineMs: number): Promise<boolean> {
    if (!Number.isInteger(version) || version < 1 || version > 2_147_483_647) {
      throw new TypeError('Invalid cache version');
    }
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0 || deadlineMs > MAX_CACHE_TIME_MS) {
      throw new TypeError('Invalid cache deadline');
    }
    return (
      (await this.run(
        () =>
          this.driver.eval(
            SET_VERSION,
            1,
            key,
            String(version),
            String(deadlineMs),
          ) as Promise<number>,
      )) === 1
    );
  }
  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    this.ttl(ttlSeconds);
    return (await this.run(() => this.driver.set(key, value, 'EX', ttlSeconds, 'NX'))) === 'OK';
  }
  async incr(key: string, ttlSeconds: number): Promise<string> {
    this.ttl(ttlSeconds);
    return this.run(() => this.driver.eval(INCR, 1, key, ttlSeconds) as Promise<string>);
  }
  async zadd(key: string, score: number, member: string, ttlSeconds: number): Promise<number> {
    this.ttl(ttlSeconds);
    if (!Number.isSafeInteger(score)) throw new TypeError('Redis score must be a safe integer');
    return this.run(
      () => this.driver.eval(ZADD, 1, key, score, member, ttlSeconds) as Promise<number>,
    );
  }
  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max)
      throw new TypeError('Invalid Redis score range');
    return this.run(() => this.driver.zrangebyscore(key, min, max));
  }
  del(key: string): Promise<number> {
    return this.run(() => this.driver.del(key));
  }
  ping(): Promise<string> {
    return this.run(() => this.driver.ping());
  }
  onModuleDestroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.breaker.shutdown();
    this.driver.disconnect(false);
  }
}
