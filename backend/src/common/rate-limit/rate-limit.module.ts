import { Global, MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { Clock, SystemClock } from '@common/clock';
import { RedisModule } from '@libs/redis';
import { IpRateLimitMiddleware } from './ip-rate-limit.middleware';
import { RateLimitMetrics } from './rate-limit.metrics';
import { RateLimiter } from './rate-limiter';

/**
 * The counters and the per-IP middleware. Global so the `TransferRateLimitGuard` that `AppModule`
 * registers as `APP_GUARD` (after `RolesGuard`) resolves the same limiter. Loaded only when the
 * process serves HTTP.
 */
@Global()
@Module({
  imports: [RedisModule],
  providers: [
    { provide: Clock, useClass: SystemClock },
    RateLimitMetrics,
    RateLimiter,
    IpRateLimitMiddleware,
  ],
  exports: [RateLimiter, RateLimitMetrics],
})
export class RateLimitModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(IpRateLimitMiddleware).forRoutes('*');
  }
}
