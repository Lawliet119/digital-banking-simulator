import { Body, Controller, Get, Header, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { CurrentUser, type CurrentUserInfo, Roles } from '@modules/identity';
import {
  CreateRiskConfigDto,
  RiskConfigListDto,
  RiskConfigVersionDto,
} from './risk-config-http.dto';
import {
  parseRiskConfigVersion,
  RiskConfigQueryPipe,
  type RiskConfigQuery,
} from './risk-config-http.query';
import { RiskConfigHttpService } from './risk-config-http.service';

@ApiTags('admin risk configuration')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED or TOKEN_EXPIRED' })
@ApiForbiddenResponse({ description: 'FORBIDDEN' })
@ApiBadRequestResponse({ description: 'Invalid configuration, version or query' })
@ApiInternalServerErrorResponse({
  description: 'Unexpected failure; creation and audit are rolled back',
})
@ApiServiceUnavailableResponse({ description: 'SERVICE_TEMPORARILY_UNAVAILABLE' })
@Roles('admin')
@Controller('admin/risk-config')
export class RiskConfigHttpController {
  constructor(private readonly risk: RiskConfigHttpService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read the latest committed risk configuration' })
  @ApiOkResponse({ type: RiskConfigVersionDto })
  @ApiNotFoundResponse({ description: 'No risk configuration exists' })
  latest(): Promise<RiskConfigVersionDto> {
    return this.risk.latest();
  }

  @Get('versions')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List immutable risk configuration versions, newest first' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1–100; default 50' })
  @ApiQuery({
    name: 'before',
    required: false,
    type: Number,
    description: 'Exclusive version cursor',
  })
  @ApiOkResponse({ type: RiskConfigListDto })
  list(@Query(new RiskConfigQueryPipe()) query: RiskConfigQuery): Promise<RiskConfigListDto> {
    return this.risk.list(query);
  }

  @Get('versions/:version')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read one immutable risk configuration version' })
  @ApiOkResponse({ type: RiskConfigVersionDto })
  @ApiNotFoundResponse({ description: 'Risk configuration version not found' })
  get(@Param('version') version: string): Promise<RiskConfigVersionDto> {
    return this.risk.get(parseRiskConfigVersion(version));
  }

  @Post('versions')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Create a new version and audit it atomically' })
  @ApiCreatedResponse({ type: RiskConfigVersionDto })
  @ApiConflictResponse({ description: 'No more PostgreSQL integer versions are available' })
  create(
    @CurrentUser() user: CurrentUserInfo,
    @Body() body: CreateRiskConfigDto,
    @Req() request: RequestWithCorrelationId,
  ): Promise<RiskConfigVersionDto> {
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.risk.create(body.config, user.userId, request.correlationId);
  }
}
