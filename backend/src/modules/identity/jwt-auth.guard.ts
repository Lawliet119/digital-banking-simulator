import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { ErrorCode } from '@common/errors/error-code.enum';
import { TokenExpiredError } from './identity.errors';
import { AuthenticatedUser } from './jwt-claims';
import { JwksVerifierService } from './jwks-verifier.service';

export type RequestWithUser = Request & { user?: AuthenticatedUser };

function unauthenticated(errorCode: ErrorCode, message: string): never {
  throw new HttpException({ errorCode, message }, HttpStatus.UNAUTHORIZED);
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly verifier: JwksVerifierService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const header = request.headers.authorization;
    const [scheme, token] = header?.split(' ') ?? [];
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
