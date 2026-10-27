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
import { AuthenticatedUser } from './jwt-claims';
import { JwksVerifierService } from './jwks-verifier.service';

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

    try {
      const claims = await this.verifier.verifyAccessToken(token);
      request.user = {
        sub: claims.sub,
        groups: claims['cognito:groups'] ?? [],
        tokenUse: 'access',
        claims,
      };
      return true;
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        unauthenticated(ErrorCode.TOKEN_EXPIRED, 'Access token expired');
      }
      unauthenticated(ErrorCode.UNAUTHENTICATED, 'Access token failed verification');
    }
  }
}
