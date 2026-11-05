import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { CurrentUser, Roles, type CurrentUserInfo } from '@modules/identity';
import { AuditEntriesPageDto, AuditSearchProblemDto } from './audit-search.dto';
import {
  AuditSearchQueryPipe,
  type AuditEntriesPage,
  type ParsedAuditSearchQuery,
} from './audit-search.query';
import { AuditSearchService } from './audit-search.service';

const problemContent = {
  'application/problem+json': { schema: { $ref: getSchemaPath(AuditSearchProblemDto) } },
};

@ApiTags('audit')
@ApiBearerAuth('access-token')
@ApiExtraModels(AuditSearchProblemDto)
@Roles('auditor')
@Controller('audit')
export class AuditController {
  constructor(private readonly searchService: AuditSearchService) {}

  @Get('entries')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Search audit entries and record this lookup atomically',
    description:
      'Auditor only, including a caller with the auditor group alongside other groups. Live keyset pagination; no cross-request snapshot. Every valid lookup, even an empty page, records audit.search before returning.',
  })
  @ApiQuery({
    name: 'actorUserId',
    required: false,
    schema: { type: 'string', format: 'uuid' },
    description: 'Exact internal users.id; UUIDs are normalized to lowercase',
  })
  @ApiQuery({
    name: 'action',
    required: false,
    schema: { type: 'string', minLength: 1, maxLength: 128 },
    description: 'Exact case-sensitive action; no control characters or whitespace-only values',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    schema: { type: 'string', format: 'date-time' },
    description: 'Inclusive UTC Z lower bound, year 1970–9999, zero to six fractional digits',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    schema: { type: 'string', format: 'date-time' },
    description: 'Exclusive UTC Z upper bound; must be later than from when both are present',
  })
  @ApiQuery({
    name: 'correlationId',
    required: false,
    schema: { type: 'string', format: 'uuid' },
    description: 'Exact trace UUID filter, separate from the server correlation of this lookup',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    description:
      'Canonical decimal integer; leading zeros, decimals and repeated values are rejected',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    schema: { type: 'string', maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' },
    description:
      'Canonical unpadded base64url keyset cursor bound to the same normalized filters; limit may change',
  })
  @ApiOkResponse({
    type: AuditEntriesPageDto,
    headers: { 'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } } },
  })
  @ApiBadRequestResponse({
    content: problemContent,
    description:
      'Invalid filters/cursor, unknown/repeated/nested query fields; fixed errors with no errorCode',
  })
  @ApiUnauthorizedResponse({
    content: problemContent,
    description: 'UNAUTHENTICATED or TOKEN_EXPIRED',
  })
  @ApiForbiddenResponse({
    content: problemContent,
    description: 'FORBIDDEN; the caller has no auditor group',
  })
  @ApiInternalServerErrorResponse({
    content: problemContent,
    description: 'Safe generic error, no entries and no errorCode',
  })
  @ApiServiceUnavailableResponse({
    content: problemContent,
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; no entries, Retry-After: 5',
    headers: { 'Retry-After': { schema: { type: 'integer', enum: [5] } } },
  })
  entries(
    // An interface emits Object metadata: the global DTO pipe must leave raw query shapes intact.
    @Query(new AuditSearchQueryPipe()) query: ParsedAuditSearchQuery,
    @CurrentUser() user: CurrentUserInfo,
    @Req() request: RequestWithCorrelationId,
  ): Promise<AuditEntriesPage> {
    return this.searchService.search(query, {
      userId: user.userId,
      correlationId: request.correlationId!,
    });
  }
}
