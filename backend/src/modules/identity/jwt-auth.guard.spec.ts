import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@common/errors/error-code.enum';
import { TokenExpiredError, TokenVerificationError } from './identity.errors';
import { CognitoAccessTokenClaims } from './jwt-claims';
import { JwtAuthGuard, RequestWithUser } from './jwt-auth.guard';
import { JwksVerifierService } from './jwks-verifier.service';

function contextWith(header?: string): { context: ExecutionContext; request: RequestWithUser } {
  const request = { headers: { authorization: header } } as RequestWithUser;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
  return { context, request };
}

function claims(overrides: Partial<CognitoAccessTokenClaims> = {}): CognitoAccessTokenClaims {
  return {
    sub: 'user-123',
    iss: 'https://issuer.test',
    client_id: 'test-client',
    token_use: 'access',
    exp: Math.floor(Date.now() / 1000) + 900,
    iat: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('JwtAuthGuard', () => {
  let verifier: { verifyAccessToken: jest.Mock };
  let reflector: Reflector;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    verifier = { verifyAccessToken: jest.fn() };
    reflector = new Reflector();
    guard = new JwtAuthGuard(verifier as unknown as JwksVerifierService, reflector);
  });

  async function expectUnauthenticated(
    promise: Promise<boolean>,
    errorCode: ErrorCode,
  ): Promise<void> {
    await expect(promise).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
      response: expect.objectContaining({ errorCode }),
    });
  }

  it('rejects with UNAUTHENTICATED and never calls the verifier when there is no header', async () => {
    const { context } = contextWith(undefined);

    await expectUnauthenticated(guard.canActivate(context), ErrorCode.UNAUTHENTICATED);
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects with UNAUTHENTICATED and never calls the verifier for a non-Bearer scheme', async () => {
    const { context } = contextWith('Basic abc123');

    await expectUnauthenticated(guard.canActivate(context), ErrorCode.UNAUTHENTICATED);
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects with UNAUTHENTICATED and never calls the verifier for "Bearer" with no token', async () => {
    const { context } = contextWith('Bearer ');

    await expectUnauthenticated(guard.canActivate(context), ErrorCode.UNAUTHENTICATED);
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('allows the request and attaches request.user when the verifier resolves', async () => {
    verifier.verifyAccessToken.mockResolvedValue(claims({ 'cognito:groups': ['operator'] }));
    const { context, request } = contextWith('Bearer good-token');

    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(verifier.verifyAccessToken).toHaveBeenCalledWith('good-token');
    expect(request.user).toEqual({
      sub: 'user-123',
      groups: ['operator'],
      tokenUse: 'access',
      claims: expect.objectContaining({ sub: 'user-123' }),
    });
  });

  it('attaches an empty groups array when the token carries no cognito:groups', async () => {
    verifier.verifyAccessToken.mockResolvedValue(claims());
    const { context, request } = contextWith('Bearer good-token');

    await guard.canActivate(context);

    expect(request.user?.groups).toEqual([]);
  });

  it('maps TokenExpiredError to 401 TOKEN_EXPIRED', async () => {
    verifier.verifyAccessToken.mockRejectedValue(new TokenExpiredError('expired'));
    const { context } = contextWith('Bearer expired-token');

    await expectUnauthenticated(guard.canActivate(context), ErrorCode.TOKEN_EXPIRED);
  });

  it('maps TokenVerificationError to 401 UNAUTHENTICATED', async () => {
    verifier.verifyAccessToken.mockRejectedValue(new TokenVerificationError('bad signature'));
    const { context } = contextWith('Bearer bad-token');

    await expectUnauthenticated(guard.canActivate(context), ErrorCode.UNAUTHENTICATED);
  });

  it('fails closed: an unexpected error from the verifier still maps to 401 UNAUTHENTICATED', async () => {
    verifier.verifyAccessToken.mockRejectedValue(new Error('boom'));
    const { context } = contextWith('Bearer whatever');

    await expectUnauthenticated(guard.canActivate(context), ErrorCode.UNAUTHENTICATED);
  });

  it('throws an HttpException instance (so ProblemDetailsFilter can handle it)', async () => {
    verifier.verifyAccessToken.mockRejectedValue(new Error('boom'));
    const { context } = contextWith('Bearer whatever');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(HttpException);
  });

  it('allows the request without calling the verifier when the handler is @Public()', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const { context } = contextWith(undefined);

    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('still requires a token when the handler is not @Public()', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const { context } = contextWith(undefined);

    await expectUnauthenticated(guard.canActivate(context), ErrorCode.UNAUTHENTICATED);
  });
});
