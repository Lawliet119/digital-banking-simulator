import {
  createParamDecorator,
  type ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ErrorCode } from '@common/errors/error-code.enum';
import type { RequestWithUser } from './jwt-auth.guard';
import { rolesFromGroups, type Role } from './roles';

/**
 * What a handler learns about its caller (DBS-51): the `users.id` (DBS-52), the Cognito `sub`,
 * and the roles. Deliberately not the claims or the raw groups: the roles are already decided,
 * and a handler that wants more should not be reading the token.
 */
export interface CurrentUserInfo {
  userId: string;
  sub: string;
  roles: Role[];
}

/**
 * The function behind `@CurrentUser()`, exported so it can be tested without a Nest app. It reads
 * `request.user` — set by JwtAuthGuard after the signature check — and nothing else, so a role or
 * a user id sent in a header or the body can never reach a handler through here.
 *
 * Every call returns a new object, so a handler that edits `roles` cannot change what a later
 * guard or handler sees. A route with no `request.user` (a `@Public()` route) gets a 401 instead
 * of `undefined`, which would turn into a 500 somewhere deeper.
 */
export function currentUserFromContext(context: ExecutionContext): CurrentUserInfo {
  const request = context.switchToHttp().getRequest<RequestWithUser>();
  const user = request.user;
  if (!user) {
    throw new HttpException(
      { errorCode: ErrorCode.UNAUTHENTICATED, message: 'Authentication is required' },
      HttpStatus.UNAUTHORIZED,
    );
  }
  return { userId: user.userId, sub: user.sub, roles: rolesFromGroups(user.groups) };
}

/** `handler(@CurrentUser() who: CurrentUserInfo)` — see `currentUserFromContext`. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  currentUserFromContext(context),
);
