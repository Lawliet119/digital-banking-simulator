import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '@common/auth/public.decorator';
import { ErrorCode } from '@common/errors/error-code.enum';
import { TokenExpiredError } from './identity.errors';
import { AuthenticatedUser, CognitoAccessTokenClaims } from './jwt-claims';
import { JwksVerifierService } from './jwks-verifier.service';
import { IdentityService } from './identity.service';

export type RequestWithUser = Request & { user?: AuthenticatedUser };

function unauthenticated(errorCode: ErrorCode, message: string): never {
  throw new HttpException({ errorCode, message }, HttpStatus.UNAUTHORIZED);
}

/**
 * The default global guard (DBS-50, registered as APP_GUARD in app.module.ts): every route is
 * authenticated unless it opts out with @Public(). A route a Dev forgets to mark either way is
 * safe by default — the opposite of forgetting @UseGuards() on an opt-in guard.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly verifier: JwksVerifierService,
    private readonly reflector: Reflector,
    private readonly identity: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const header = request.headers.authorization;
    const [scheme, token] = header?.split(' ') ?? [];
    // Case-sensitive on purpose: every client in this system (Swagger UI, the k6 scripts, the
    // frontend) always sends the canonical "Bearer" — being stricter than RFC 7235 here only
    // rejects malformed input, it can never be used to bypass the guard.
    if (scheme !== 'Bearer' || !token) {
      unauthenticated(ErrorCode.UNAUTHENTICATED, 'Missing or malformed Authorization header');
    }

    let claims: CognitoAccessTokenClaims;
    try {
      claims = await this.verifier.verifyAccessToken(token);
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        unauthenticated(ErrorCode.TOKEN_EXPIRED, 'Access token expired');
      }
      unauthenticated(ErrorCode.UNAUTHENTICATED, 'Access token failed verification');
    }

    // The database is touched only after the signature and every claim check passed: a caller
    // with a bad token cannot add rows to `users`. This sits outside the try/catch above on
    // purpose — a database failure is not an authentication failure, so it must not turn into a
    // 401 (the client would sign in again for nothing); it escapes to ProblemDetailsFilter, which
    // answers 503 for a transient error.
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
      unauthenticated(ErrorCode.UNAUTHENTICATED, 'Access token has no subject');
    }
    const userId = await this.identity.resolveUserId(claims.sub);

    // A token issued at or before the user's revocation mark is dead (BR-12, NFR-SEC-02). Whole
    // seconds, because `iat` has no finer resolution: a token minted in the same second as the lock
    // is refused too, which is the safe side. Like the lookup above, a database failure here is a
    // 503, not a 401.
    const revokedAt = await this.identity.sessionsRevokedAt(userId);
    const issuedAt = typeof claims.iat === 'number' ? claims.iat : 0;
    if (revokedAt && issuedAt <= Math.floor(revokedAt.getTime() / 1000)) {
      unauthenticated(ErrorCode.SESSION_REVOKED, 'Session has been revoked');
    }

    request.user = {
      sub: claims.sub,
      userId,
      groups: claims['cognito:groups'] ?? [],
      tokenUse: 'access',
      claims,
    };
    return true;
  }
}
