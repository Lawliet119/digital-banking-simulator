import { Controller, Get, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { RequestWithUser } from './jwt-auth.guard';
import { AuthenticatedUser } from './jwt-claims';
import { AuthenticatedUserDto } from './identity.dto';

@ApiTags('identity')
@Controller('identity')
export class IdentityController {
  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Verified caller claims (smoke-test endpoint for JwtAuthGuard)' })
  @ApiOkResponse({
    type: AuthenticatedUserDto,
    description: 'Verified claims and resolved internal userId',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid token (errorCode UNAUTHENTICATED) or expired (TOKEN_EXPIRED)',
  })
  me(@Req() req: RequestWithUser): AuthenticatedUser {
    return req.user as AuthenticatedUser;
  }
}
