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
import { ApiErrorCodes } from '@common/openapi/api-error-codes.decorator';
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
  @ApiErrorCodes({
    400: [ErrorCode.IDEMPOTENCY_KEY_REQUIRED],
    422: [ErrorCode.ACCOUNT_NOT_ACTIVE, ErrorCode.IDEMPOTENCY_KEY_REUSED],
  })
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
  @ApiBadRequestResponse({ description: 'IDEMPOTENCY_KEY_REQUIRED or invalid DTO/key length' })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED / TOKEN_EXPIRED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN' })
  @ApiUnprocessableEntityResponse({
    description: 'ACCOUNT_NOT_ACTIVE with persisted transferId, or IDEMPOTENCY_KEY_REUSED',
  })
  @ApiInternalServerErrorResponse({
    description: 'Internal server error; entire transaction rolled back',
  })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; retry same key after Retry-After',
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
