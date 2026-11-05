import { BadRequestException, Body, Controller, Headers, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser, type CurrentUserInfo, Roles } from '@modules/identity';
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { ErrorCode } from '@common/errors/error-code.enum';
import { TransferDto, TransferResultDto } from './transfer.dto';
import { TransferService } from './transfer.service';

@ApiTags('transfers')
@ApiBearerAuth('access-token')
@Roles('customer')
@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransferService) {}

  @Post()
  @ApiOperation({
    summary: 'Customer: transfer between distinct customer accounts with atomic double entry',
    description:
      'Source must belong to caller. Basic ACTIVE/balance checks only; per-transfer/day limits are pending. First execution only; reused keys return409. Stored-result replay is not supported yet.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength: 128 },
  })
  @ApiCreatedResponse({ type: TransferResultDto })
  @ApiBadRequestResponse({
    description: 'IDEMPOTENCY_KEY_REQUIRED or invalid DTO/key length/same account',
  })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED / TOKEN_EXPIRED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN' })
  @ApiNotFoundResponse({
    description: 'Source account not found; includes foreign and SYSTEM sources',
  })
  @ApiConflictResponse({
    description: 'Idempotency key already used; reuse is not accepted by this endpoint',
  })
  @ApiUnprocessableEntityResponse({
    description: 'ACCOUNT_NOT_ACTIVE / INSUFFICIENT_FUNDS; persisted transferId in problem+json',
  })
  @ApiInternalServerErrorResponse({
    description: 'Internal server error; all business writes rolled back',
  })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; retry same key after Retry-After',
  })
  transfer(
    @CurrentUser() user: CurrentUserInfo,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: TransferDto,
    @Req() request: RequestWithCorrelationId,
  ): Promise<TransferResultDto> {
    if (typeof key !== 'string' || !key.trim())
      throw new BadRequestException({
        errorCode: ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        message: 'Idempotency-Key is required',
      });
    if ([...key].length > 128)
      throw new BadRequestException('Idempotency-Key must contain at most128 characters');
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.transfers.transfer(user.userId, key, body, request.correlationId);
  }
}
