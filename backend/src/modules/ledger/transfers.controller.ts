import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser, type CurrentUserInfo, Roles } from '@modules/identity';
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { ErrorCode } from '@common/errors/error-code.enum';
import { TransferDto, TransferResultDto } from './transfer.dto';
import { TransferQueryService } from './transfer-query.service';
import { TransferStatusDto } from './transfer-status.dto';
import { TransferService } from './transfer.service';

@ApiTags('transfers')
@ApiBearerAuth('access-token')
@Roles('customer')
@Controller('transfers')
export class TransfersController {
  constructor(
    private readonly transfers: TransferService,
    private readonly queries: TransferQueryService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Customer: transfer between distinct customer accounts with atomic double entry',
    description:
      'Source must belong to caller. Checks, in order under the account lock: both accounts ACTIVE, per-transfer limit, per-day limit (Vietnam time), enough money; the first rule broken is the reason. Idempotent: the same key with the same body returns the first answer without a second transfer; the same key with another body is 422 IDEMPOTENCY_KEY_REUSED.',
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
  @ApiUnprocessableEntityResponse({
    description:
      'ACCOUNT_NOT_ACTIVE / INSUFFICIENT_FUNDS / LIMIT_PER_TX_EXCEEDED / LIMIT_PER_DAY_EXCEEDED with persisted transferId, or IDEMPOTENCY_KEY_REUSED',
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
      throw new BadRequestException('Idempotency-Key must contain at most 128 characters');
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.transfers.transfer(user.userId, key, body, request.correlationId);
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Customer: status of a transfer the caller sent or received',
    description:
      'The sender sees any status; the recipient only a COMPLETED transfer. Anyone else, a transfer that does not exist and a malformed id are the same 404. A REJECTED transfer shows its reason but never a destination account.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'transferId returned by POST /v1/transfers',
  })
  @ApiOkResponse({ type: TransferStatusDto })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED / TOKEN_EXPIRED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN; the caller is not a customer' })
  @ApiNotFoundResponse({ description: 'Transfer not found, or the caller is not a party to it' })
  @ApiInternalServerErrorResponse({ description: 'Internal server error; no data if audit fails' })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; Retry-After seconds',
  })
  status(
    @CurrentUser() user: CurrentUserInfo,
    @Param('id') transferId: string,
    @Req() request: RequestWithCorrelationId,
  ): Promise<TransferStatusDto> {
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.queries.get(user.userId, transferId, request.correlationId);
  }
}
