import { BadRequestException, Body, Controller, Headers, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
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
import { ErrorCode } from '@common/errors/error-code.enum';
import { DepositDto, DepositResultDto } from './deposit.dto';
import { DepositService } from './deposit.service';

@ApiTags('operator deposits')
@ApiBearerAuth('access-token')
@Roles('operator')
@Controller('operator/deposits')
export class OperatorDepositsController {
  constructor(private readonly deposits: DepositService) {}
  @Post()
  @ApiOperation({
    summary: 'Operator: deposit from SYSTEM funding with atomic double entry',
    description:
      'Idempotent: the same key with the same body returns the first answer without a second deposit; the same key with another body is 422 IDEMPOTENCY_KEY_REUSED.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength: 128 },
  })
  @ApiCreatedResponse({ type: DepositResultDto })
  @ApiBadRequestResponse({
    description: 'IDEMPOTENCY_KEY_REQUIRED or invalid DTO/key length',
    schema: {
      example: {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        errorCode: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'Idempotency-Key is required',
        correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'UNAUTHENTICATED / TOKEN_EXPIRED',
    schema: {
      example: {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        errorCode: 'UNAUTHENTICATED',
        detail: 'Authentication is required',
        correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'FORBIDDEN; the caller is not an operator',
    schema: {
      example: {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        errorCode: 'FORBIDDEN',
        detail: "The caller's role is not allowed to use this endpoint.",
        correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description: 'ACCOUNT_NOT_ACTIVE with persisted transferId, or IDEMPOTENCY_KEY_REUSED',
    schema: {
      examples: {
        ACCOUNT_NOT_ACTIVE: {
          summary: 'Target account is not active (BR-12)',
          value: {
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            errorCode: 'ACCOUNT_NOT_ACTIVE',
            detail: 'Target account is locked or inactive',
            transferId: '33333333-3333-4333-8333-333333333333',
            correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
          },
        },
        IDEMPOTENCY_KEY_REUSED: {
          summary: 'Key reused with different body (BR-07)',
          value: {
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            errorCode: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'Idempotency key reused with different request payload',
            correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
          },
        },
      },
    },
  })
  @ApiInternalServerErrorResponse({
    description: 'Internal server error; entire transaction rolled back',
  })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; retry same key after Retry-After',
    headers: {
      'Retry-After': {
        description: 'Seconds before retry',
        schema: { type: 'integer', example: 5 },
      },
    },
    schema: {
      example: {
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        errorCode: 'SERVICE_TEMPORARILY_UNAVAILABLE',
        detail: 'Service temporarily unavailable — please retry.',
        correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
      },
    },
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
      throw new BadRequestException('Idempotency-Key must contain at most128 characters');
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.deposits.deposit(user.userId, key, body, request.correlationId);
  }
}
