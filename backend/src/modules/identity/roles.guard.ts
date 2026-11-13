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
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import type { RequestWithUser } from './jwt-auth.guard';
import { RoleDenialAudit } from './role-denial-audit';
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
 * - Wrong role: 403 `FORBIDDEN`, handler not run, one `warn` log line and one audit `DENIED` row.
 *
 * The audit row (BL-132, FR-AUD-02) is written through `RoleDenialAudit`, in its own transaction,
 * before the 403 is thrown. It fails closed: if the row cannot be written the audit error escapes
 * and the caller gets 500/503 instead of a 403 with no evidence behind it. Access is still denied
 * (the handler never ran); only the status code changes. This costs no availability that was not
 * already gone, because `JwtAuthGuard` has already read PostgreSQL for the same request.
 *
 * The `warn` line stays on purpose: it is the operational signal (searchable in CloudWatch with no
 * database round trip) and the only trace left when the audit write itself fails. Both hold the
 * roles because they exist nowhere else — there is no `users.role` — and never the token, the
 * `sub`, the groups, the claims or the URL (a query string can carry anything).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: RoleDenialAudit,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<unknown>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser & RequestWithCorrelationId>();
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
    const routeTemplate = typeof route?.path === 'string' ? route.path : UNKNOWN_ROUTE;
    this.logger.warn(
      {
        userId: request.user.userId,
        method: request.method,
        route: routeTemplate,
        requiredRoles: allowed ?? [],
        roles: callerRoles,
      },
      'Request denied: role not allowed',
    );
    // No fallback id: `correlationIdMiddleware` always sets it, so a missing one is a wiring bug
    // that must show up as a failure, not as a denial filed under a made-up code.
    if (!request.correlationId) {
      throw new Error(
        'RolesGuard needs request.correlationId (correlationIdMiddleware not applied)',
      );
    }
    await this.audit.recordRoleDenied({
      userId: request.user.userId,
      roles: callerRoles,
      method: request.method,
      route: routeTemplate,
      correlationId: request.correlationId,
    });
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
