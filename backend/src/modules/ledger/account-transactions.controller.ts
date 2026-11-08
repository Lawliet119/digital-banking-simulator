import { Controller, Get, Header, Param, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
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
import { TransactionPageDto } from './transaction-history.dto';
import { HistoryQueryPipe, type ParsedHistoryQuery } from './transaction-history.query';
import { TransactionHistoryService } from './transaction-history.service';

@ApiTags('accounts')
@ApiBearerAuth('access-token')
@Roles('customer')
@Controller('accounts')
export class AccountTransactionsController {
  constructor(private readonly history: TransactionHistoryService) {}

  @Get(':id/transactions')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Customer: transaction history of an owned account, newest first, keyset pagination',
    description:
      'Completed transfers and deposits that moved money in or out of the account (one ledger line each). Rejected transfers are not part of the history: read them by transferId. No OFFSET: pass nextCursor back as cursor. A cursor only works with the filters it was issued for.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
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
  @ApiBadRequestResponse({ description: 'Invalid limit, cursor, from or to; unknown parameter' })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED or TOKEN_EXPIRED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN; the caller is not a customer' })
  @ApiNotFoundResponse({ description: 'Account not found (includes foreign and SYSTEM accounts)' })
  @ApiInternalServerErrorResponse({ description: 'Internal server error; no data if audit fails' })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; Retry-After seconds',
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
