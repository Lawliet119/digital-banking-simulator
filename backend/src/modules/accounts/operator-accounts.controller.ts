import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
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
import { OperatorAccountSearchDto } from './operator-account-search.dto';
import { SearchQueryPipe, type ParsedSearch } from './operator-account-search.query';
import { OperatorAccountSearchService } from './operator-account-search.service';
import {
  OperatorAccountStatusBodyDto,
  OperatorAccountStatusResponseDto,
} from './operator-account-status.dto';
import { OperatorAccountStatusService } from './operator-account-status.service';

@ApiTags('operator')
@ApiBearerAuth('access-token')
@Roles('operator')
@Controller('operator/accounts')
export class OperatorAccountsController {
  constructor(
    private readonly search: OperatorAccountSearchService,
    private readonly status: OperatorAccountStatusService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Operator: find a customer account by account id or part of the owner name',
    description:
      'Returns at most 20 accounts (id, type, status, owner name) and never a balance. A whole UUID finds that account; anything else is a case-insensitive partial match on the owner name (% and _ are plain characters). Every valid lookup, even an empty one, is audited before the answer is returned; the audit row keeps the operator, the number of results and an account id or a SHA-256 fingerprint of the name, never the name.',
  })
  @ApiQuery({
    name: 'q',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength: 100 },
    description: 'Account UUID, or part of the owner name; trimmed, NFC, no control characters',
  })
  @ApiOkResponse({ type: OperatorAccountSearchDto })
  @ApiBadRequestResponse({ description: 'q missing, blank, too long, with control characters' })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED or TOKEN_EXPIRED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN; the caller is not an operator' })
  @ApiInternalServerErrorResponse({ description: 'Internal server error; no data if audit fails' })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; Retry-After seconds',
  })
  find(
    // An interface emits Object metadata: the global DTO pipe must leave raw query shapes intact.
    @Query(new SearchQueryPipe()) search: ParsedSearch,
    @CurrentUser() user: CurrentUserInfo,
    @Req() request: RequestWithCorrelationId,
  ): Promise<OperatorAccountSearchDto> {
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.search.search(user.userId, search, request.correlationId);
  }

  @Post(':id/lock')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Operator: lock a customer account with a mandatory reason (UC-11)',
    description:
      'Atomically locks a customer account (status = LOCKED), revokes the owner active sessions (users.sessions_revoked_at = clock_timestamp()), writes a fail-closed audit row, and emits AccountStatusChanged in one transaction. Never returns a balance and never exposes the lock reason in events or customer responses (BR-13).',
  })
  @ApiParam({ name: 'id', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ type: OperatorAccountStatusBodyDto })
  @ApiOkResponse({ type: OperatorAccountStatusResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid account UUID or invalid/missing reason',
    schema: {
      example: {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'Invalid status reason',
        errors: ['Reason must not be blank'],
        correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED, TOKEN_EXPIRED, or SESSION_REVOKED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN; the caller is not an operator' })
  @ApiNotFoundResponse({
    description: 'Account does not exist or is a SYSTEM account',
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
  @ApiInternalServerErrorResponse({
    description: 'Internal server error; rolls back if audit or outbox fails',
  })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; Retry-After seconds',
  })
  lock(
    @Param('id') id: string,
    @Body() body: OperatorAccountStatusBodyDto,
    @CurrentUser() user: CurrentUserInfo,
    @Req() request: RequestWithCorrelationId,
  ): Promise<OperatorAccountStatusResponseDto> {
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.status.lock(user.userId, id, body, request.correlationId);
  }

  @Post(':id/unlock')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Operator: unlock a customer account with a mandatory reason (UC-11)',
    description:
      'Atomically unlocks a customer account (status = ACTIVE), writes a fail-closed audit row, and emits AccountStatusChanged in one transaction without clearing prior session revocation timestamps.',
  })
  @ApiParam({ name: 'id', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ type: OperatorAccountStatusBodyDto })
  @ApiOkResponse({ type: OperatorAccountStatusResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid account UUID or invalid/missing reason',
    schema: {
      example: {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'Invalid status reason',
        errors: ['Reason must not be blank'],
        correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED, TOKEN_EXPIRED, or SESSION_REVOKED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN; the caller is not an operator' })
  @ApiNotFoundResponse({
    description: 'Account does not exist or is a SYSTEM account',
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
  @ApiInternalServerErrorResponse({
    description: 'Internal server error; rolls back if audit or outbox fails',
  })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; Retry-After seconds',
  })
  unlock(
    @Param('id') id: string,
    @Body() body: OperatorAccountStatusBodyDto,
    @CurrentUser() user: CurrentUserInfo,
    @Req() request: RequestWithCorrelationId,
  ): Promise<OperatorAccountStatusResponseDto> {
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.status.unlock(user.userId, id, body, request.correlationId);
  }
}
