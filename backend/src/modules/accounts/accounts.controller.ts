import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiOkResponse,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorCode } from '@common/errors/error-code.enum';
import { ApiErrorCodes } from '@common/openapi/api-error-codes.decorator';
import { CurrentUser, type CurrentUserInfo, Roles } from '@modules/identity';
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { AccountOpeningService } from './account-opening.service';
import { CreateAccountDto, OpenedAccountDto } from './open-account.dto';
import { AccountQueryService } from './account-query.service';
import { AccountViewDto } from './account-view.dto';

@ApiTags('accounts')
@ApiBearerAuth('access-token')
@Roles('customer')
@Controller('accounts')
export class AccountsController {
  constructor(
    private readonly opening: AccountOpeningService,
    private readonly queries: AccountQueryService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Customer: list own accounts and committed PostgreSQL balances' })
  @ApiOkResponse({ type: AccountViewDto, isArray: true })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED or TOKEN_EXPIRED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN' })
  @ApiInternalServerErrorResponse({ description: 'Internal server error; no data if audit fails' })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; Retry-After seconds',
  })
  list(
    @CurrentUser() user: CurrentUserInfo,
    @Req() request: RequestWithCorrelationId,
  ): Promise<AccountViewDto[]> {
    return this.queries.list(user.userId, this.correlationId(request));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Customer: read one owned account and its committed balance' })
  @ApiParam({
    name: 'id',
    description: 'Account UUID; invalid, missing or foreign account returns404',
    format: 'uuid',
  })
  @ApiOkResponse({ type: AccountViewDto })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED or TOKEN_EXPIRED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN' })
  @ApiNotFoundResponse({ description: 'Account not found (includes invalid, foreign and SYSTEM)' })
  @ApiInternalServerErrorResponse({ description: 'Internal server error; no data if audit fails' })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; Retry-After seconds',
  })
  get(
    @CurrentUser() user: CurrentUserInfo,
    @Param('id') accountId: string,
    @Req() request: RequestWithCorrelationId,
  ): Promise<AccountViewDto> {
    return this.queries.get(user.userId, accountId, this.correlationId(request));
  }

  private correlationId(request: RequestWithCorrelationId): string {
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return request.correlationId;
  }

  @Post()
  @ApiErrorCodes({ 409: [ErrorCode.ACCOUNT_LIMIT_REACHED] })
  @ApiOperation({ summary: 'Customer: open a CHECKING or SAVINGS account (maximum three)' })
  @ApiCreatedResponse({ type: OpenedAccountDto })
  @ApiBadRequestResponse({ description: 'Invalid account type or extra body fields' })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED or TOKEN_EXPIRED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN' })
  @ApiNotFoundResponse({ description: 'Customer profile not created yet' })
  @ApiConflictResponse({
    description: 'ACCOUNT_LIMIT_REACHED',
    schema: {
      example: {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        errorCode: 'ACCOUNT_LIMIT_REACHED',
        detail: 'Customer account limit reached',
        correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
      },
    },
  })
  @ApiInternalServerErrorResponse({
    description: 'Unexpected failure; no account created without audit',
  })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_TEMPORARILY_UNAVAILABLE; retry after transient DB failure',
    headers: {
      'Retry-After': {
        description: 'Seconds before retry',
        schema: { type: 'integer', example: 1 },
      },
    },
  })
  open(
    @CurrentUser() user: CurrentUserInfo,
    @Body() body: CreateAccountDto,
    @Req() request: RequestWithCorrelationId,
  ): Promise<OpenedAccountDto> {
    if (!request.correlationId) throw new Error('Missing server correlation context');
    return this.opening.open(user.userId, body.type, request.correlationId);
  }
}
