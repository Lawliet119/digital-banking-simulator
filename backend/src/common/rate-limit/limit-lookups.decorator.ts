import { SetMetadata } from '@nestjs/common';

export const LIMIT_LOOKUPS_KEY = 'limitLookups';

/**
 * Marks a route that tells a customer who owns an account number (`GET /v1/accounts/lookup`). The
 * global `LookupRateLimitGuard` reads it and counts the request against
 * `RATE_LIMIT_LOOKUPS_PER_MINUTE`, so the endpoint cannot be used to walk the number space.
 * Metadata, not `@UseGuards()`, for the same reason as `@LimitTransfers()`.
 */
export const LimitLookups = () => SetMetadata(LIMIT_LOOKUPS_KEY, true);
