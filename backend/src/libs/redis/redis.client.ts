import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { redisConfig } from '@config/redis.config';
import Redis from 'ioredis';
import CircuitBreaker from 'opossum';
import { RedisMetrics } from './redis.metrics';

export type RedisFailureReason =
  'TIMEOUT' | 'CIRCUIT_OPEN' | 'UNAVAILABLE' | 'COMMAND_FAILED' | 'SHUTDOWN';
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

@Injectable()
export class RedisClient implements OnModuleDestroy {
  private readonly driver: Redis;
  private readonly breaker: CircuitBreaker<[() => Promise<unknown>], unknown>;
  private disposed = false;
  constructor(
    @Inject(redisConfig.KEY) config: ConfigType<typeof redisConfig>,
    private readonly metrics: RedisMetrics,
  ) {
    if (!Number.isInteger(config.commandTimeoutMs) || config.commandTimeoutMs < 10)
      throw new TypeError('Invalid Redis command timeout');
    const timeout = Math.min(config.commandTimeoutMs, 50);
    this.driver = new Redis(config.url, {
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
      throw new TypeError('Redis TTL must be an integer from1 to604800 seconds');
  }
  get(key: string): Promise<string | null> {
    return this.run(() => this.driver.get(key));
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<string> {
    this.ttl(ttlSeconds);
    return this.run(() => this.driver.set(key, value, 'EX', ttlSeconds));
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
