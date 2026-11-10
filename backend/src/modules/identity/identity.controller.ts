import { Controller, Get, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtension,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorCode, ProblemDetailsDto, problemContent } from '@common/errors';
import type { RequestWithUser } from './jwt-auth.guard';
import { AuthenticatedUser } from './jwt-claims';
import { AuthenticatedUserDto } from './authenticated-user.dto';

@ApiTags('identity')
@ApiBearerAuth('access-token')
@ApiExtraModels(ProblemDetailsDto, AuthenticatedUserDto)
@Controller('identity')
export class IdentityController {
  @Get('me')
  @ApiExtension('x-roles', ['customer', 'operator', 'auditor', 'admin'])
  @ApiOperation({
    summary: 'Verified caller claims (smoke-test endpoint for JwtAuthGuard)',
    description:
      '[Authenticated - Mọi vai trò] Trả claims đã xác thực của người gọi (smoke test cho JwtAuthGuard, DBS-50). Cho phép bất kỳ vai trò hợp lệ nào (customer, operator, auditor, admin).',
  })
  @ApiOkResponse({
    description: 'Verified caller identity and token claims',
    type: AuthenticatedUserDto,
  })
  @ApiUnauthorizedResponse({
    description: 'UNAUTHENTICATED, TOKEN_EXPIRED, or SESSION_REVOKED',
    content: problemContent(ProblemDetailsDto, {
      unauthenticated: {
        summary: 'UNAUTHENTICATED',
        value: {
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'Missing or invalid token',
          errorCode: ErrorCode.UNAUTHENTICATED,
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
      tokenExpired: {
        summary: 'TOKEN_EXPIRED',
        value: {
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'Access token has expired',
          errorCode: ErrorCode.TOKEN_EXPIRED,
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
      sessionRevoked: {
        summary: 'SESSION_REVOKED',
        value: {
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'Session revoked',
          errorCode: ErrorCode.SESSION_REVOKED,
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
  })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; transient database error',
    content: problemContent(ProblemDetailsDto, {
      serviceUnavailable: {
        summary: 'SERVICE_TEMPORARILY_UNAVAILABLE',
        value: {
          type: 'about:blank',
          title: 'Service Unavailable',
          status: 503,
          detail: 'Database temporarily unavailable',
          errorCode: ErrorCode.SERVICE_TEMPORARILY_UNAVAILABLE,
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
  })
  me(@Req() req: RequestWithUser): AuthenticatedUser {
    return req.user as AuthenticatedUser;
  }
}
