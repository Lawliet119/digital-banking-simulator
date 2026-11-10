import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, type CurrentUserInfo, Roles } from '@modules/identity';
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { ErrorCode, ProblemDetailsDto, problemContent } from '@common/errors';
import { CreateCustomerProfileDto, CustomerProfileDto } from './customer-profile.dto';
import { CustomerProfileService } from './customer-profile.service';

@ApiTags('customers')
@ApiBearerAuth('access-token')
@ApiExtraModels(ProblemDetailsDto)
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
  }),
})
@ApiForbiddenResponse({
  description: 'FORBIDDEN; customer role required',
  content: problemContent(ProblemDetailsDto, {
    forbidden: {
      summary: 'FORBIDDEN',
      value: {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Forbidden resource',
        errorCode: ErrorCode.FORBIDDEN,
        correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
      },
    },
  }),
})
@ApiInternalServerErrorResponse({
  description: 'Internal server error; audit failure returns no profile',
  content: problemContent(ProblemDetailsDto, {
    internalError: {
      summary: 'INTERNAL_SERVER_ERROR',
      value: {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred',
        correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
      },
    },
  }),
})
@ApiServiceUnavailableResponse({
  description: 'SERVICE_TEMPORARILY_UNAVAILABLE',
  content: problemContent(ProblemDetailsDto, {
    unavailable: {
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
@Roles('customer')
@Controller('customers')
export class CustomersController {
  constructor(private readonly profiles: CustomerProfileService) {}

  @Post('me')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Customer: create own profile, or return the existing profile unchanged (UC-1)',
    description:
      '[Customer] Idempotent theo user_id. Tạo mới hồ sơ khách hàng (fullName NFC/trim 1..200 ký tự) hoặc trả lại hồ sơ đã tạo trước đó.',
  })
  @ApiOkResponse({ type: CustomerProfileDto })
  @ApiBadRequestResponse({
    description: 'Invalid fullName or additional body fields',
    content: problemContent(ProblemDetailsDto, {
      badRequest: {
        summary: 'Validation Error',
        value: {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'Validation failed',
          errors: ['fullName must be shorter than or equal to 200 characters'],
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
  })
  create(
    @CurrentUser() user: CurrentUserInfo,
    @Body() body: CreateCustomerProfileDto,
    @Req() request: RequestWithCorrelationId,
  ): Promise<CustomerProfileDto> {
    return this.profiles.createOrGet(user.userId, body.fullName, this.correlationId(request));
  }

  @Get('me')
  @ApiOperation({
    summary: 'Customer: read own customer profile (UC-1)',
    description: '[Customer] Đọc hồ sơ khách hàng của người gọi.',
  })
  @ApiOkResponse({ type: CustomerProfileDto })
  @ApiNotFoundResponse({
    description: 'Customer profile not created yet',
    content: problemContent(ProblemDetailsDto, {
      notFound: {
        summary: 'Not Found',
        value: {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'Customer profile not found',
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
  })
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
