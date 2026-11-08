import { SetMetadata } from '@nestjs/common';

export const LIMIT_TRANSFERS_KEY = 'limitTransfers';

/**
 * Marks a route as a money-moving request that counts against the per-customer limit
 * (`RATE_LIMIT_TRANSFERS_PER_MINUTE`). The global `TransferRateLimitGuard` reads it. It is
 * metadata, not `@UseGuards()`: a test module that does not load `RateLimitModule` leaves the
 * route as it was, and the production `AppModule` always registers the guard.
 */
export const LimitTransfers = () => SetMetadata(LIMIT_TRANSFERS_KEY, true);
