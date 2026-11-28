import { Body, Controller, Get, Header, HttpCode, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
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
import {
  MarkReadPipe,
  NOTIFICATION_FILTERS,
  NotificationQueryPipe,
  type ParsedNotificationQuery,
} from './notification-query';
import { NotificationQueryService } from './notification-query.service';
import { NotificationPageDto, NotificationReadDto } from './notification-view.dto';

@ApiTags('notifications')
@ApiBearerAuth('access-token')
@Roles('customer')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly queries: NotificationQueryService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Customer: own notifications, newest first, keyset pagination',
    description:
      'Ordered by the time the event happened. Pass nextCursor back as cursor; there is no OFFSET.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    schema: { type: 'string', maxLength: 256, pattern: '^[A-Za-z0-9_-]+$' },
  })
  @ApiQuery({
    name: 'filter',
    required: false,
    schema: { type: 'string', enum: [...NOTIFICATION_FILTERS], default: 'all' },
    description: 'in = money received, out = money sent, account = lock and unlock',
  })
  @ApiOkResponse({ type: NotificationPageDto })
  @ApiBadRequestResponse({ description: 'Invalid limit, filter or cursor; unknown parameter' })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED or TOKEN_EXPIRED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN; the caller is not a customer' })
  @ApiInternalServerErrorResponse({ description: 'Internal server error' })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; Retry-After seconds',
  })
  list(
    @CurrentUser() user: CurrentUserInfo,
    // An interface emits Object metadata: the global DTO pipe must leave raw query shapes intact.
    @Query(new NotificationQueryPipe()) query: ParsedNotificationQuery,
  ): Promise<NotificationPageDto> {
    return this.queries.list(user.userId, query);
  }

  @Post('read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Customer: mark own notifications read, from upToId down in list order',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['upToId'],
      properties: { upToId: { type: 'string', example: '42' } },
      additionalProperties: false,
    },
  })
  @ApiOkResponse({ type: NotificationReadDto })
  @ApiBadRequestResponse({ description: 'upToId is missing or not a notification id' })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED or TOKEN_EXPIRED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN; the caller is not a customer' })
  @ApiInternalServerErrorResponse({ description: 'Internal server error' })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; Retry-After seconds',
  })
  markRead(
    @CurrentUser() user: CurrentUserInfo,
    @Body(new MarkReadPipe()) upToId: string,
  ): Promise<NotificationReadDto> {
    return this.queries.markRead(user.userId, upToId);
  }
}
