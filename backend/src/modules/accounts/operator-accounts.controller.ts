import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
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

@ApiTags('operator')
@ApiBearerAuth('access-token')
@Roles('operator')
@Controller('operator/accounts')
export class OperatorAccountsController {
  constructor(private readonly search: OperatorAccountSearchService) {}

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
}
