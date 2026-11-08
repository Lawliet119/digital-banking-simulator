import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '@common/clock';
import { RedisClient, RedisUnavailableError } from '@libs/redis';
import { RateLimitMetrics, type RateLimitScope } from './rate-limit.metrics';

const WINDOW_MS = 60_000;
const WINDOW_SECONDS = 60;

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window ends (1..60) when refused; 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window counters in Redis (docs/03 §9, R-1). The key carries the minute, so every counter
 * lives at most 60 seconds and a client that sends steadily is not pushed over the limit by a
 * window that keeps sliding (`RedisClient.incr` renews the TTL on every call, which would do
 * exactly that on one fixed key). The price is the usual fixed-window burst of up to twice the
 * limit across a minute boundary.
 *
 * It fails open: any Redis problem (timeout, breaker open, outage) lets the request through
 * (docs/03 §9.3). `RedisClient` has already counted it in `redis_fallback_total`.
 */
@Injectable()
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);

  constructor(
    private readonly redis: RedisClient,
    private readonly clock: Clock,
    private readonly metrics: RateLimitMetrics,
  ) {}

  async hit(scope: RateLimitScope, id: string, limit: number): Promise<RateLimitDecision> {
    const nowMs = this.clock.now().getTime();
    const minute = Math.floor(nowMs / WINDOW_MS);
    try {
      const count = Number(await this.redis.incr(`rl:${scope}:${id}:${minute}`, WINDOW_SECONDS));
      if (!Number.isFinite(count)) return this.open('BAD_COUNT');
      if (count <= limit) return { allowed: true, retryAfterSeconds: 0 };
      this.metrics.limited(scope);
      const left = Math.ceil(((minute + 1) * WINDOW_MS - nowMs) / 1000);
      return { allowed: false, retryAfterSeconds: Math.min(WINDOW_SECONDS, Math.max(1, left)) };
    } catch (error) {
      // The reason code only: a key would hold an IP or a user id.
      return this.open(error instanceof RedisUnavailableError ? error.reason : 'UNEXPECTED');
    }
  }

  private open(reason: string): RateLimitDecision {
    this.logger.warn(`rate limit skipped, request allowed (${reason})`);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
