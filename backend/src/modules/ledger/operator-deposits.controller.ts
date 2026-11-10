import { BadRequestException, Body, Controller, Headers, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser, type CurrentUserInfo, Roles } from '@modules/identity';
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { ErrorCode, ProblemDetailsDto, problemContent } from '@common/errors';
import { DepositDto, DepositResultDto } from './deposit.dto';
import { DepositService } from './deposit.service';

@ApiTags('operator deposits')
@ApiBearerAuth('access-token')
@ApiExtraModels(ProblemDetailsDto)
@Roles('operator')
@Controller('operator/deposits')
export class OperatorDepositsController {
  constructor(private readonly deposits: DepositService) {}

  @Post()
  @ApiOperation({
    summary: 'Operator: deposit from SYSTEM funding with atomic double entry (UC-3)',
    description:
      '[Operator] Idempotent: the same key with the same body returns the first answer without a second deposit; the same key with another body is 422 IDEMPOTENCY_KEY_REUSED.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique 1..128 character client key scoped to user_id (retained at least 7 days)',
    schema: { type: 'string', minLength: 1, maxLength: 128, example: 'idem-deposit-20261110-001' },
  })
  @ApiCreatedResponse({ type: DepositResultDto })
  @ApiBadRequestResponse({
    description: 'IDEMPOTENCY_KEY_REQUIRED or invalid DTO/key length',
    content: problemContent(ProblemDetailsDto, {
      keyRequired: {
        summary: 'IDEMPOTENCY_KEY_REQUIRED',
        value: {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'Idempotency-Key is required',
          errorCode: ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
      validationError: {
        summary: 'Validation Error',
        value: {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'Validation failed',
          errors: ['amount must be a positive whole VND string (1..9223372036854775807)'],
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
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
    }),
  })
  @ApiForbiddenResponse({
    description: 'FORBIDDEN; operator role required',
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
  @ApiUnprocessableEntityResponse({
    description: 'ACCOUNT_NOT_ACTIVE with persisted transferId, or IDEMPOTENCY_KEY_REUSED',
    content: problemContent(ProblemDetailsDto, {
      accountNotActive: {
        summary: 'ACCOUNT_NOT_ACTIVE',
        value: {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'Destination account is not active',
          errorCode: ErrorCode.ACCOUNT_NOT_ACTIVE,
          transferId: '8f78e873-7dab-481a-9bbf-577d35e49dd7',
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
      keyReused: {
        summary: 'IDEMPOTENCY_KEY_REUSED',
        value: {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'Idempotency key reused with different request payload',
          errorCode: ErrorCode.IDEMPOTENCY_KEY_REUSED,
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
  })
  @ApiInternalServerErrorResponse({
    description: 'Internal server error; entire transaction rolled back',
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
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; retry same key after Retry-After',
    headers: {
      'Retry-After': {
        description: 'Seconds before retry',
        schema: { type: 'integer', example: 5 },
      },
    },
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
  deposit(
    @CurrentUser() user: CurrentUserInfo,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: DepositDto,
    @Req() request: RequestWithCorrelationId,
  ): Promise<DepositResultDto> {
    if (typeof key !== 'string' || !key.trim())
      throw new BadRequestException({
        errorCode: ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        message: 'Idempotency-Key is required',
      });
    if ([...key].length > 128)
      throw new BadRequestException('Idempotency-Key must contain at most 128 characters');
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.deposits.deposit(user.userId, key, body, request.correlationId);
  }
}
