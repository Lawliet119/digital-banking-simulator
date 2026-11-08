import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { limitsConfig } from '@config/limits.config';
import { LIMIT_TRANSFERS_KEY } from './limit-transfers.decorator';
import { rateLimited } from './rate-limited.exception';
import { RateLimiter } from './rate-limiter';

type RequestWithUser = Request & { user?: { userId?: string } };

/**
 * 10 transfer requests per minute per customer (NFR-SEC-05). A global guard registered AFTER
 * `JwtAuthGuard` and `RolesGuard`, so it knows the internal `users.id`; it acts only on a route
 * marked `@LimitTransfers()`. It refuses before the controller body, so a refused request makes
 * no database call. A replay with the same `Idempotency-Key` counts like any other request: the
 * limit is about abuse, not about money.
 */
@Injectable()
export class TransferRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly reflector: Reflector,
    @Inject(limitsConfig.KEY) private readonly limits: ConfigType<typeof limitsConfig>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const marked = this.reflector.getAllAndOverride<boolean>(LIMIT_TRANSFERS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!marked) return true;
    const http = context.switchToHttp();
    const userId = http.getRequest<RequestWithUser>().user?.userId;
    // No user means no token was checked for this route; the IP limit still applies.
    if (!userId) return true;
    const decision = await this.limiter.hit(
      'user',
      userId,
      this.limits.rateLimit.transfersPerMinute,
    );
    if (decision.allowed) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(decision.retryAfterSeconds));
    throw rateLimited();
  }
}
