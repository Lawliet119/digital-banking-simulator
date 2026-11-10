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
  ApiExtraModels,
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
import { ErrorCode, ProblemDetailsDto, problemContent } from '@common/errors';
import { LimitTransfers } from '@common/rate-limit/limit-transfers.decorator';
import { TransferDto, TransferResultDto } from './transfer.dto';
import { TransferQueryService } from './transfer-query.service';
import { TransferStatusDto } from './transfer-status.dto';
import { TransferService } from './transfer.service';

@ApiTags('transfers')
@ApiBearerAuth('access-token')
@ApiExtraModels(ProblemDetailsDto)
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
    summary:
      'Customer: transfer between distinct customer accounts with atomic double entry (UC-5)',
    description:
      '[Customer] Nguồn phải thuộc về caller. Kiểm tra tuần tự dưới khóa tài khoản: hai tài khoản ACTIVE, hạn mức mỗi lần, hạn mức ngày (giờ VN), đủ tiền. Idempotent: cùng key cùng body trả lại kết quả cũ; cùng key khác body trả 422 IDEMPOTENCY_KEY_REUSED.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique 1..128 character client key scoped to user_id (retained at least 7 days)',
    schema: { type: 'string', minLength: 1, maxLength: 128, example: 'idem-transfer-20261110-001' },
  })
  @ApiCreatedResponse({ type: TransferResultDto })
  @ApiBadRequestResponse({
    description: 'IDEMPOTENCY_KEY_REQUIRED or validation error',
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
  @ApiNotFoundResponse({
    description: 'Source account not found; includes foreign and SYSTEM sources',
    content: problemContent(ProblemDetailsDto, {
      notFound: {
        summary: 'Not Found',
        value: {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'Source account not found',
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Business rejections with persisted transferId (ACCOUNT_NOT_ACTIVE, INSUFFICIENT_FUNDS, LIMIT_PER_TX_EXCEEDED, LIMIT_PER_DAY_EXCEEDED) or IDEMPOTENCY_KEY_REUSED',
    content: problemContent(ProblemDetailsDto, {
      insufficientFunds: {
        summary: 'INSUFFICIENT_FUNDS',
        value: {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'Insufficient funds',
          errorCode: ErrorCode.INSUFFICIENT_FUNDS,
          transferId: '7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a',
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
      accountNotActive: {
        summary: 'ACCOUNT_NOT_ACTIVE',
        value: {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'Account is not active',
          errorCode: ErrorCode.ACCOUNT_NOT_ACTIVE,
          transferId: '7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a',
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
      limitPerTx: {
        summary: 'LIMIT_PER_TX_EXCEEDED',
        value: {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'Per-transaction limit exceeded',
          errorCode: ErrorCode.LIMIT_PER_TX_EXCEEDED,
          transferId: '7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a',
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
      limitPerDay: {
        summary: 'LIMIT_PER_DAY_EXCEEDED',
        value: {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'Daily transfer limit exceeded',
          errorCode: ErrorCode.LIMIT_PER_DAY_EXCEEDED,
          transferId: '7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a',
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
      keyReused: {
        summary: 'IDEMPOTENCY_KEY_REUSED',
        value: {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'Idempotency-Key reused with different request payload',
          errorCode: ErrorCode.IDEMPOTENCY_KEY_REUSED,
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
  })
  @ApiTooManyRequestsResponse({
    description: 'RATE_LIMITED: transfer request limit exceeded; Retry-After seconds',
    headers: {
      'Retry-After': {
        description: 'Seconds before retry',
        schema: { type: 'integer', example: 42 },
      },
    },
    content: problemContent(ProblemDetailsDto, {
      rateLimited: {
        summary: 'RATE_LIMITED',
        value: {
          type: 'about:blank',
          title: 'Too Many Requests',
          status: 429,
          detail: 'Rate limit exceeded: at most 10 transfers per minute per customer',
          errorCode: ErrorCode.RATE_LIMITED,
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
  })
  @ApiInternalServerErrorResponse({
    description: 'Internal server error; all business writes rolled back',
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
    summary: 'Customer: status of a transfer the caller sent or received (UC-7)',
    description:
      '[Customer] The sender sees any status; the recipient only a COMPLETED transfer. Anyone else, a transfer that does not exist and a malformed id are the same 404. A REJECTED transfer shows its reason but never a destination account.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    example: '7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a',
    description: 'transferId returned by POST /v1/transfers',
  })
  @ApiOkResponse({ type: TransferStatusDto })
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
    description: 'FORBIDDEN; the caller is not a customer',
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
  @ApiNotFoundResponse({
    description: 'Transfer not found, or the caller is not a party to it',
    content: problemContent(ProblemDetailsDto, {
      notFound: {
        summary: 'Not Found',
        value: {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'Transfer not found',
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
  })
  @ApiInternalServerErrorResponse({
    description: 'Internal server error; no data if audit fails',
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
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; Retry-After seconds',
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
  status(
    @CurrentUser() user: CurrentUserInfo,
    @Param('id') transferId: string,
    @Req() request: RequestWithCorrelationId,
  ): Promise<TransferStatusDto> {
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.queries.get(user.userId, transferId, request.correlationId);
  }
}
