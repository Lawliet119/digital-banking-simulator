import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { limitsConfig } from '@config/limits.config';
import { LIMIT_LOOKUPS_KEY } from './limit-lookups.decorator';
import { rateLimited } from './rate-limited.exception';
import { RateLimiter } from './rate-limiter';

type RequestWithUser = Request & { user?: { userId?: string } };

/**
 * `RATE_LIMIT_LOOKUPS_PER_MINUTE` (default 20) account-number lookups per minute per customer. Same
 * shape as `TransferRateLimitGuard`: global, registered after `RolesGuard`, acts only on a route
 * marked `@LimitLookups()`, fails open when Redis is down. It counts under its own scope, so a
 * customer who looks up recipients does not use up the 10 transfers per minute.
 */
@Injectable()
export class LookupRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly reflector: Reflector,
    @Inject(limitsConfig.KEY) private readonly limits: ConfigType<typeof limitsConfig>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const marked = this.reflector.getAllAndOverride<boolean>(LIMIT_LOOKUPS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!marked) return true;
    const http = context.switchToHttp();
    const userId = http.getRequest<RequestWithUser>().user?.userId;
    if (!userId) return true;
    const decision = await this.limiter.hit(
      'lookup',
      userId,
      this.limits.rateLimit.lookupsPerMinute,
    );
    if (decision.allowed) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(decision.retryAfterSeconds));
    throw rateLimited();
  }
}
