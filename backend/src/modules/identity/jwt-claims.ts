export interface CognitoAccessTokenClaims {
  sub: string;
  iss: string;
  client_id: string;
  token_use: 'access' | 'id';
  exp: number;
  iat: number;
  'cognito:groups'?: string[];
  [claim: string]: unknown;
}

/**
 * Attached to `request.user` by JwtAuthGuard. `groups` is always an array — never undefined —
 * so a later role guard can apply "no groups → customer" without a null check. `userId` is
 * `users.id` (DBS-52), never undefined once the guard has let the request through: the guard
 * answers 401/503 instead of leaving it empty.
 */
export interface AuthenticatedUser {
  sub: string;
  userId: string;
  groups: string[];
  tokenUse: 'access';
  claims: CognitoAccessTokenClaims;
}
