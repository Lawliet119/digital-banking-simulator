import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@common/errors/error-code.enum';
import type { RequestWithUser } from './jwt-auth.guard';
import { ROLES, rolesFromGroups, type Role } from './roles';
import { ROLES_KEY } from './roles.decorator';

/** Shown in the denial log when Express did not set `request.route`. Never the URL. */
const UNKNOWN_ROUTE = '(unknown route)';

function forbidden(): never {
  // The text is fixed on purpose: it must not say which role the caller has or which is needed.
  throw new HttpException(
    {
      errorCode: ErrorCode.FORBIDDEN,
      message: "The caller's role is not allowed to use this endpoint.",
    },
    HttpStatus.FORBIDDEN,
  );
}

/**
 * Second global guard (DBS-51, APP_GUARD in app.module.ts, registered after JwtAuthGuard): checks
 * the roles a route declares with `@Roles`. It trusts `request.user` and nothing else — never a
 * header, the body, the query or a cookie — because `request.user.groups` is the only value that
 * comes from a token whose signature has been verified.
 *
 * - No `@Roles` (metadata `undefined`): the route needs only a valid token (decision G1).
 * - `@Roles` metadata that is damaged (empty, not a list, an unknown name): 403. `@Roles` itself
 *   refuses such a list, so this only happens when someone writes the metadata by hand, and
 *   "open to everyone" would be the worst way to fail.
 * - `@Roles` on a `@Public()` route: there is no `request.user`, so 401 (fail closed).
 * - Wrong role: 403 `FORBIDDEN`, handler not run, one `warn` log line (see below).
 *
 * The log line is the hook for the audit `DENIED` record that DBS-56 will write at this point
 * (FR-AUD-02). It holds the roles because they exist nowhere else — there is no `users.role` —
 * and never the token, the `sub`, the groups, the claims or the URL (a query string can carry
 * anything).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<unknown>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) {
      throw new HttpException(
        { errorCode: ErrorCode.UNAUTHENTICATED, message: 'Authentication is required' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    const callerRoles = rolesFromGroups(request.user.groups);
    const allowed = this.validRoles(required);
    if (allowed !== undefined && allowed.some(role => callerRoles.includes(role))) {
      return true;
    }

    // Express types `route` as any. Only the path template is read, never `url`/`originalUrl`.
    const route = request.route as { path?: unknown } | undefined;
    this.logger.warn(
      {
        userId: request.user.userId,
        method: request.method,
        route: typeof route?.path === 'string' ? route.path : UNKNOWN_ROUTE,
        requiredRoles: allowed ?? [],
        roles: callerRoles,
      },
      'Request denied: role not allowed',
    );
    return forbidden();
  }

  /** The declared list when it is a non-empty array of known role names, otherwise `undefined`. */
  private validRoles(required: unknown): Role[] | undefined {
    if (!Array.isArray(required) || required.length === 0) {
      return undefined;
    }
    const valid = (required as unknown[]).every(
      item => typeof item === 'string' && (ROLES as readonly string[]).includes(item),
    );
    return valid ? (required as Role[]) : undefined;
  }
}
