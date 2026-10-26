import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { JwtAuthGuard, RequestWithUser } from './jwt-auth.guard';
import { AuthenticatedUser } from './jwt-claims';

@ApiTags('identity')
@Controller('identity')
export class IdentityController {
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Verified caller claims (smoke-test endpoint for JwtAuthGuard)' })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid token (errorCode UNAUTHENTICATED) or expired (TOKEN_EXPIRED)',
  })
  me(@Req() req: RequestWithUser): AuthenticatedUser {
    return req.user as AuthenticatedUser;
  }
}
