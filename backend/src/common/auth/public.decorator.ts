import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route or an entire controller as not requiring authentication. `JwtAuthGuard` is the
 * default global guard (DBS-50) — every route needs a valid access token unless it opts out with
 * this decorator. Used by routes a load balancer or an unauthenticated client must reach, such as
 * the health probes.
 */
export const Public = (): ReturnType<typeof SetMetadata> => SetMetadata(IS_PUBLIC_KEY, true);
