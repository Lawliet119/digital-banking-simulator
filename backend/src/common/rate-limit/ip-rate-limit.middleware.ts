import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { limitsConfig } from '@config/limits.config';
import { clientIp } from './client-ip';
import { rateLimited } from './rate-limited.exception';
import { RateLimiter } from './rate-limiter';

/** The probes of the load balancer and the platform: never part of the limit. */
export function isHealthPath(path: string): boolean {
  return path === '/health' || path.startsWith('/health/');
}

/**
 * Every HTTP request counts against its client IP (NFR-SEC-05, docs/03 §9 R-1): 100 per minute by
 * default. It is a middleware, not a guard, on purpose: a guard only runs for a route that
 * matched, so a client hammering paths that do not exist would not be counted, and it runs before
 * `JwtAuthGuard`, so a flood with no token or a bad one is stopped before any token is verified.
 * Which address is counted depends on `TRUST_PROXY_HOPS` (see `clientIp`).
 */
@Injectable()
export class IpRateLimitMiddleware implements NestMiddleware {
  constructor(
    private readonly limiter: RateLimiter,
    // Read at call time, not copied: the limit is configuration.
    @Inject(limitsConfig.KEY) private readonly limits: ConfigType<typeof limitsConfig>,
  ) {}

  async use(request: Request, response: Response, next: NextFunction): Promise<void> {
    // originalUrl, not path: Express strips the mount point of a middleware from `path`.
    if (isHealthPath(request.originalUrl.split('?')[0])) return next();
    const decision = await this.limiter.hit(
      'ip',
      clientIp(request),
      this.limits.rateLimit.requestsPerIpPerMinute,
    );
    if (decision.allowed) return next();
    response.setHeader('Retry-After', String(decision.retryAfterSeconds));
    // An exception thrown here reaches the same ProblemDetailsFilter as any other 429.
    next(rateLimited());
  }
}
