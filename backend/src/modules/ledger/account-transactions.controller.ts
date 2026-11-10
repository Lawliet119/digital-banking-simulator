import { Controller, Get, Header, Param, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, type CurrentUserInfo, Roles } from '@modules/identity';
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { ErrorCode, ProblemDetailsDto, problemContent } from '@common/errors';
import { TransactionPageDto } from './transaction-history.dto';
import { HistoryQueryPipe, type ParsedHistoryQuery } from './transaction-history.query';
import { TransactionHistoryService } from './transaction-history.service';

@ApiTags('accounts')
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
@Roles('customer')
@Controller('accounts')
export class AccountTransactionsController {
  constructor(private readonly history: TransactionHistoryService) {}

  @Get(':id/transactions')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Customer: transaction history of an owned account, newest first (UC-6)',
    description:
      '[Customer] Completed transfers and deposits that moved money in or out of the account (one ledger line each). Keyset pagination (no OFFSET). Rejected transfers are not part of history.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    example: '2e859a80-d4d0-471d-8cee-e9d0de9d4bc7',
    description: 'Account UUID; an invalid, missing, foreign or SYSTEM account is the same 404',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    schema: { type: 'string', maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' },
  })
  @ApiQuery({
    name: 'from',
    required: false,
    schema: { type: 'string', format: 'date-time' },
    description: 'Inclusive UTC Z lower bound',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    schema: { type: 'string', format: 'date-time' },
    description: 'Exclusive UTC Z upper bound; must be later than from',
  })
  @ApiOkResponse({ type: TransactionPageDto })
  @ApiBadRequestResponse({
    description: 'Invalid limit, cursor, from or to; unknown parameter',
    content: problemContent(ProblemDetailsDto, {
      badRequest: {
        summary: 'Bad Request',
        value: {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'Validation failed',
          errors: ['limit must not be greater than 100'],
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
  })
  @ApiNotFoundResponse({
    description: 'Account not found (includes foreign and SYSTEM accounts)',
    content: problemContent(ProblemDetailsDto, {
      notFound: {
        summary: 'Not Found',
        value: {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'Account not found',
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
  })
  transactions(
    @CurrentUser() user: CurrentUserInfo,
    @Param('id') accountId: string,
    // An interface emits Object metadata: the global DTO pipe must leave raw query shapes intact.
    @Query(new HistoryQueryPipe()) query: ParsedHistoryQuery,
    @Req() request: RequestWithCorrelationId,
  ): Promise<TransactionPageDto> {
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.history.list(user.userId, accountId, query, request.correlationId);
  }
}
