import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExtraModels,
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
import { CurrentUser, type CurrentUserInfo, Roles } from '@modules/identity';
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { ErrorCode, ProblemDetailsDto, problemContent } from '@common/errors';
import { AccountOpeningService } from './account-opening.service';
import { CreateAccountDto, OpenedAccountDto } from './open-account.dto';
import { AccountQueryService } from './account-query.service';
import { AccountViewDto } from './account-view.dto';

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
  description: 'FORBIDDEN; customer role required',
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
  headers: {
    'Retry-After': {
      description: 'Seconds before retry',
      schema: { type: 'integer', example: 5 },
    },
  },
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
export class AccountsController {
  constructor(
    private readonly opening: AccountOpeningService,
    private readonly queries: AccountQueryService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Customer: list own accounts and committed PostgreSQL balances (UC-4)',
    description:
      '[Customer] Trả về danh sách tài khoản thuộc quyền sở hữu của người gọi kèm số dư cam kết từ PostgreSQL.',
  })
  @ApiOkResponse({ type: AccountViewDto, isArray: true })
  list(
    @CurrentUser() user: CurrentUserInfo,
    @Req() request: RequestWithCorrelationId,
  ): Promise<AccountViewDto[]> {
    return this.queries.list(user.userId, this.correlationId(request));
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Customer: read one owned account and its committed balance (UC-4)',
    description:
      '[Customer] Xem chi tiết một tài khoản của chính mình. Tài khoản không tồn tại, sai định dạng UUID, thuộc người khác hoặc là SYSTEM_CASH đều trả về cùng mã 404 (chống enumeration).',
  })
  @ApiParam({
    name: 'id',
    description: 'Account UUID; invalid, missing or foreign account returns 404',
    format: 'uuid',
    example: '2e859a80-d4d0-471d-8cee-e9d0de9d4bc7',
  })
  @ApiOkResponse({ type: AccountViewDto })
  @ApiNotFoundResponse({
    description: 'Account not found (includes invalid, foreign and SYSTEM accounts)',
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
  @ApiOperation({
    summary: 'Customer: open a CHECKING or SAVINGS account, maximum three (UC-2)',
    description:
      '[Customer] Mở thêm tài khoản thanh toán hoặc tiết kiệm. Giới hạn tối đa 3 tài khoản cho mỗi khách hàng (tính cả ACTIVE và LOCKED). Vượt quá trả 409 ACCOUNT_LIMIT_REACHED.',
  })
  @ApiCreatedResponse({ type: OpenedAccountDto })
  @ApiBadRequestResponse({
    description: 'Invalid account type or extra body fields',
    content: problemContent(ProblemDetailsDto, {
      badRequest: {
        summary: 'Validation Error',
        value: {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'Validation failed',
          errors: ['type must be one of the following values: CHECKING, SAVINGS'],
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
  })
  @ApiNotFoundResponse({
    description: 'Customer profile not created yet',
    content: problemContent(ProblemDetailsDto, {
      notFound: {
        summary: 'Not Found',
        value: {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'Customer profile not found',
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
  })
  @ApiConflictResponse({
    description: 'ACCOUNT_LIMIT_REACHED',
    content: problemContent(ProblemDetailsDto, {
      limitReached: {
        summary: 'ACCOUNT_LIMIT_REACHED',
        value: {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          errorCode: ErrorCode.ACCOUNT_LIMIT_REACHED,
          detail: 'Customer account limit reached',
          correlationId: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
        },
      },
    }),
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
