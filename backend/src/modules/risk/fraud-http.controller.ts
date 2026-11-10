import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
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
import { CurrentUser, type CurrentUserInfo, Roles } from '@modules/identity';
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { FraudDetailDto, FraudListDto, ReviewFraudDto } from './fraud-http.dto';
import { FraudQueryPipe, type FraudQuery } from './fraud-http.query';
import { FraudHttpService } from './fraud-http.service';

@ApiTags('operator fraud')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED or TOKEN_EXPIRED' })
@ApiForbiddenResponse({ description: 'FORBIDDEN; operator role required' })
@ApiBadRequestResponse({ description: 'VALIDATION_ERROR; malformed query, UUID or body' })
@ApiInternalServerErrorResponse({
  description: 'Internal server error; audit failure returns no data and rolls back review',
})
@ApiServiceUnavailableResponse({ description: 'SERVICE_TEMPORARILY_UNAVAILABLE' })
@Roles('operator')
@Controller('operator/fraud-flags')
export class FraudHttpController {
  constructor(private readonly fraud: FraudHttpService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List flags, HIGH first then creation time and transfer UUID descending',
  })
  @ApiQuery({
    name: 'review_status',
    required: false,
    enum: ['OPEN', 'CONFIRMED_FRAUD', 'FALSE_POSITIVE'],
  })
  @ApiQuery({ name: 'level', required: false, enum: ['MEDIUM', 'HIGH'] })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiOkResponse({ type: FraudListDto })
  list(
    @Query(new FraudQueryPipe()) query: FraudQuery,
    @CurrentUser() user: CurrentUserInfo,
    @Req() request: RequestWithCorrelationId,
  ): Promise<FraudListDto> {
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.fraud.list(query, user.userId, request.correlationId);
  }

  @Get(':transferId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read canonical flag detail and record mandatory access audit' })
  @ApiOkResponse({ type: FraudDetailDto })
  @ApiNotFoundResponse({ description: 'NOT_FOUND' })
  detail(
    @Param('transferId', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserInfo,
    @Req() request: RequestWithCorrelationId,
  ): Promise<FraudDetailDto> {
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.fraud.detail(id, user.userId, request.correlationId);
  }

  @Post(':transferId/review')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Review an OPEN flag exactly once; no account lock or outbox event' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['transferId', 'reviewStatus'],
      properties: {
        transferId: { type: 'string', format: 'uuid' },
        reviewStatus: { type: 'string', enum: ['CONFIRMED_FRAUD', 'FALSE_POSITIVE'] },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'NOT_FOUND' })
  @ApiConflictResponse({ description: 'FLAG_ALREADY_REVIEWED' })
  review(
    @Param('transferId', new ParseUUIDPipe()) id: string,
    @Body() body: ReviewFraudDto,
    @CurrentUser() user: CurrentUserInfo,
    @Req() request: RequestWithCorrelationId,
  ): Promise<{ transferId: string; reviewStatus: string }> {
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.fraud.review(id, body, user.userId, request.correlationId);
  }
}
