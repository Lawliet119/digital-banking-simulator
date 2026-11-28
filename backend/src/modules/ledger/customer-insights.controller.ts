import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Injectable,
  Param,
  Query,
  Req,
  type PipeTransform,
} from '@nestjs/common';
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
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { CurrentUser, type CurrentUserInfo, Roles } from '@modules/identity';
import {
  CustomerSummaryDto,
  RecentRecipientsDto,
  TransferLimitsDto,
} from './customer-insights.dto';
import { CustomerInsightsService } from './customer-insights.service';

/** `?days=` of the summary: 1 (today) or 30, default 30; nothing else. */
@Injectable()
export class SummaryQueryPipe implements PipeTransform<unknown, 1 | 30> {
  transform(value: unknown): 1 | 30 {
    const query = value as Record<string, unknown>;
    const keys = Object.keys(query);
    const days = query.days ?? '30';
    if (keys.some(key => key !== 'days') || (days !== '1' && days !== '30')) {
      throw new BadRequestException({ errors: ['days must be 1 or 30'] });
    }
    return days === '1' ? 1 : 30;
  }
}

function correlationOf(request: RequestWithCorrelationId): string {
  if (!request.correlationId) throw new Error('Missing server correlation context');
  return request.correlationId;
}

@ApiTags('accounts')
@ApiBearerAuth('access-token')
@Roles('customer')
@Controller()
export class CustomerInsightsController {
  constructor(private readonly insights: CustomerInsightsService) {}

  @Get('accounts/:id/limits')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Customer: transfer limits of an owned account and what is left today' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Account UUID' })
  @ApiOkResponse({ type: TransferLimitsDto })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED or TOKEN_EXPIRED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN; the caller is not a customer' })
  @ApiNotFoundResponse({ description: 'Account not found (includes foreign and SYSTEM accounts)' })
  @ApiInternalServerErrorResponse({ description: 'Internal server error; no data if audit fails' })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; Retry-After seconds',
  })
  limits(
    @CurrentUser() user: CurrentUserInfo,
    @Param('id') accountId: string,
    @Req() request: RequestWithCorrelationId,
  ): Promise<TransferLimitsDto> {
    return this.insights.limitsOf(user.userId, accountId, correlationOf(request));
  }

  @Get('insights/summary')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Customer: money in and out today or over 30 days, per own account',
    description:
      'Calendar days in Vietnam time, today included. The totals leave out transfers between the customer’s own accounts.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    schema: { type: 'integer', enum: [1, 30], default: 30 },
  })
  @ApiOkResponse({ type: CustomerSummaryDto })
  @ApiBadRequestResponse({ description: 'days is not 1 or 30; unknown parameter' })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED or TOKEN_EXPIRED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN; the caller is not a customer' })
  @ApiInternalServerErrorResponse({ description: 'Internal server error; no data if audit fails' })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; Retry-After seconds',
  })
  summary(
    @CurrentUser() user: CurrentUserInfo,
    @Query(new SummaryQueryPipe()) days: 1 | 30,
    @Req() request: RequestWithCorrelationId,
  ): Promise<CustomerSummaryDto> {
    return this.insights.summary(user.userId, days, correlationOf(request));
  }

  @Get('insights/recipients')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Customer: the last accounts the customer sent money to' })
  @ApiOkResponse({ type: RecentRecipientsDto })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED or TOKEN_EXPIRED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN; the caller is not a customer' })
  @ApiInternalServerErrorResponse({ description: 'Internal server error; no data if audit fails' })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; Retry-After seconds',
  })
  recipients(
    @CurrentUser() user: CurrentUserInfo,
    @Req() request: RequestWithCorrelationId,
  ): Promise<RecentRecipientsDto> {
    return this.insights.recipients(user.userId, correlationOf(request));
  }
}
