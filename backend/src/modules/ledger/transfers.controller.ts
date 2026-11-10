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
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser, type CurrentUserInfo, Roles } from '@modules/identity';
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { ErrorCode } from '@common/errors/error-code.enum';
import { LimitTransfers } from '@common/rate-limit/limit-transfers.decorator';
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
  @LimitTransfers()
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
    description: 'UNAUTHENTICATED / TOKEN_EXPIRED / SESSION_REVOKED',
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
    description: 'FORBIDDEN',
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
  @ApiNotFoundResponse({
    description: 'Source account not found; includes foreign and SYSTEM sources',
    schema: {
      example: {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Account not found',
        correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description:
      'ACCOUNT_NOT_ACTIVE / INSUFFICIENT_FUNDS / LIMIT_PER_TX_EXCEEDED / LIMIT_PER_DAY_EXCEEDED with persisted transferId, or IDEMPOTENCY_KEY_REUSED',
    schema: {
      examples: {
        LIMIT_PER_DAY_EXCEEDED: {
          summary: 'Daily limit exceeded (BR-06)',
          value: {
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            errorCode: 'LIMIT_PER_DAY_EXCEEDED',
            detail: 'Daily transfer limit exceeded',
            transferId: '11111111-1111-4111-8111-111111111111',
            correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
          },
        },
        INSUFFICIENT_FUNDS: {
          summary: 'Insufficient funds (BR-03)',
          value: {
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            errorCode: 'INSUFFICIENT_FUNDS',
            detail: 'Insufficient funds for transfer',
            transferId: '22222222-2222-4222-8222-222222222222',
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
    description: 'Internal server error; all business writes rolled back',
  })
  @ApiTooManyRequestsResponse({
    description:
      'RATE_LIMITED: more than RATE_LIMIT_TRANSFERS_PER_MINUTE (10) transfer requests this minute; Retry-After seconds. Nothing was written',
    schema: {
      example: {
        type: 'about:blank',
        title: 'Too Many Requests',
        status: 429,
        errorCode: 'RATE_LIMITED',
        detail: 'Too many requests',
        correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
      },
    },
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
