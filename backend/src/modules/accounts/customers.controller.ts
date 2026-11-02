import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, type CurrentUserInfo, Roles } from '@modules/identity';
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { CreateCustomerProfileDto, CustomerProfileDto } from './customer-profile.dto';
import { CustomerProfileService } from './customer-profile.service';

@ApiTags('customers')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED or TOKEN_EXPIRED' })
@ApiForbiddenResponse({ description: 'FORBIDDEN: customer role required' })
@ApiInternalServerErrorResponse({
  description: 'Internal server error; audit failure returns no profile',
})
@Roles('customer')
@Controller('customers')
export class CustomersController {
  constructor(private readonly profiles: CustomerProfileService) {}

  @Post('me')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create own profile, or return the existing profile unchanged' })
  @ApiOkResponse({ type: CustomerProfileDto })
  @ApiBadRequestResponse({ description: 'Invalid fullName or additional body fields' })
  create(
    @CurrentUser() user: CurrentUserInfo,
    @Body() body: CreateCustomerProfileDto,
    @Req() request: RequestWithCorrelationId,
  ): Promise<CustomerProfileDto> {
    return this.profiles.createOrGet(user.userId, body.fullName, this.correlationId(request));
  }

  @Get('me')
  @ApiOperation({ summary: 'Read own customer profile' })
  @ApiOkResponse({ type: CustomerProfileDto })
  @ApiNotFoundResponse({ description: 'Customer profile not created yet' })
  get(
    @CurrentUser() user: CurrentUserInfo,
    @Req() request: RequestWithCorrelationId,
  ): Promise<CustomerProfileDto> {
    return this.profiles.get(user.userId, this.correlationId(request));
  }

  private correlationId(request: RequestWithCorrelationId): string {
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return request.correlationId;
  }
}
