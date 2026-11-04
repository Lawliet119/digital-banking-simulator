import { BadRequestException, Body, Controller, Headers, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
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
      'First execution only; reused keys409 until DBS-79 replay support. No external network inside transaction.',
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
  @ApiConflictResponse({
    description: 'Key already used; full replay/conflict handling pending DBS-79',
  })
  @ApiUnprocessableEntityResponse({ description: 'ACCOUNT_NOT_ACTIVE with persisted transferId' })
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
