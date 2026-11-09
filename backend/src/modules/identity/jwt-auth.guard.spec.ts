import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@common/errors/error-code.enum';
import { TokenExpiredError, TokenVerificationError } from './identity.errors';
import { CognitoAccessTokenClaims } from './jwt-claims';
import { JwtAuthGuard, RequestWithUser } from './jwt-auth.guard';
import { JwksVerifierService } from './jwks-verifier.service';
import { IdentityService } from './identity.service';

const USER_ID = '0f6a3d52-8c1b-4e7a-b6d4-2c9e1a7f5b30';

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
  let identity: { resolveUserId: jest.Mock; sessionsRevokedAt: jest.Mock };
  let reflector: Reflector;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    verifier = { verifyAccessToken: jest.fn() };
    identity = {
      resolveUserId: jest.fn().mockResolvedValue(USER_ID),
      sessionsRevokedAt: jest.fn().mockResolvedValue(null),
    };
    reflector = new Reflector();
    guard = new JwtAuthGuard(
      verifier as unknown as JwksVerifierService,
      reflector,
      identity as unknown as IdentityService,
    );
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
      userId: USER_ID,
      groups: ['operator'],
      tokenUse: 'access',
      claims: expect.objectContaining({ sub: 'user-123' }),
    });
  });

  it('TC-52-08 resolves the user id AFTER the token is verified, from the verified sub', async () => {
    verifier.verifyAccessToken.mockResolvedValue(claims({ sub: 'verified-sub' }));
    const { context, request } = contextWith('Bearer good-token');

    await guard.canActivate(context);

    expect(identity.resolveUserId).toHaveBeenCalledTimes(1);
    expect(identity.resolveUserId).toHaveBeenCalledWith('verified-sub');
    expect(verifier.verifyAccessToken.mock.invocationCallOrder[0]).toBeLessThan(
      identity.resolveUserId.mock.invocationCallOrder[0],
    );
    expect(request.user?.userId).toBe(USER_ID);
  });

  describe('session revocation (BR-12)', () => {
    const revokedAtSecond = 1_000;
    const run = (iat: number | undefined, revoked: number | null) => {
      verifier.verifyAccessToken.mockResolvedValue(
        claims(iat === undefined ? { iat: undefined as unknown as number } : { iat }),
      );
      identity.sessionsRevokedAt.mockResolvedValue(
        revoked === null ? null : new Date(revoked * 1000 + 400),
      );
      const { context, request } = contextWith('Bearer good');
      return { result: guard.canActivate(context), request };
    };

    it('refuses a token issued before the revocation mark', async () => {
      const { result, request } = run(revokedAtSecond - 5, revokedAtSecond);
      await expectUnauthenticated(result, ErrorCode.SESSION_REVOKED);
      expect(request.user).toBeUndefined();
    });

    it('refuses a token issued in the same second as the mark', async () => {
      const { result } = run(revokedAtSecond, revokedAtSecond);
      await expectUnauthenticated(result, ErrorCode.SESSION_REVOKED);
    });

    it('refuses a token with no iat once the user has been revoked', async () => {
      const { result } = run(undefined, revokedAtSecond);
      await expectUnauthenticated(result, ErrorCode.SESSION_REVOKED);
    });

    it.each([Infinity, NaN, -1, 1000.5, Number.MAX_SAFE_INTEGER + 1])(
      'TC-114-08 invalid issued-at %s cannot bypass revocation',
      async iat => {
        const { result } = run(iat, revokedAtSecond);
        await expectUnauthenticated(result, ErrorCode.SESSION_REVOKED);
        expect(identity.sessionsRevokedAt).toHaveBeenCalledWith(USER_ID, 0);
      },
    );

    it('lets a token issued after the mark through', async () => {
      const { result, request } = run(revokedAtSecond + 1, revokedAtSecond);
      await expect(result).resolves.toBe(true);
      expect(request.user?.userId).toBe(USER_ID);
    });

    it('lets everyone through when the user was never revoked', async () => {
      const { result } = run(1, null);
      await expect(result).resolves.toBe(true);
    });

    it('answers a failing revocation lookup with the error, never with a 401', async () => {
      verifier.verifyAccessToken.mockResolvedValue(claims());
      identity.sessionsRevokedAt.mockRejectedValue(new Error('db down'));
      const { context } = contextWith('Bearer good');
      await expect(guard.canActivate(context)).rejects.toThrow('db down');
    });
  });

  it.each([
    ['expired', new TokenExpiredError('expired'), ErrorCode.TOKEN_EXPIRED],
    ['badly signed', new TokenVerificationError('bad signature'), ErrorCode.UNAUTHENTICATED],
    ['rejected for an unexpected reason', new Error('boom'), ErrorCode.UNAUTHENTICATED],
  ])(
    'TC-52-09 never resolves a user id for a token that is %s',
    async (_label, failure, errorCode) => {
      verifier.verifyAccessToken.mockRejectedValue(failure);
      const { context, request } = contextWith('Bearer bad-token');

      await expectUnauthenticated(guard.canActivate(context), errorCode);

      expect(identity.resolveUserId).not.toHaveBeenCalled();
      expect(request.user).toBeUndefined();
    },
  );

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 42],
  ])(
    'TC-52-11 answers 401 UNAUTHENTICATED and never touches the database when a verified sub is %s',
    async (_label, sub) => {
      verifier.verifyAccessToken.mockResolvedValue(claims({ sub: sub as unknown as string }));
      const { context, request } = contextWith('Bearer good-token');

      await expectUnauthenticated(guard.canActivate(context), ErrorCode.UNAUTHENTICATED);

      expect(identity.resolveUserId).not.toHaveBeenCalled();
      expect(request.user).toBeUndefined();
    },
  );

  it('TC-52-12 lets a database failure escape as-is: it is not an authentication failure', async () => {
    const failure = Object.assign(new Error('terminating connection'), { code: '57P01' });
    verifier.verifyAccessToken.mockResolvedValue(claims());
    identity.resolveUserId.mockRejectedValue(failure);
    const { context, request } = contextWith('Bearer good-token');

    await expect(guard.canActivate(context)).rejects.toBe(failure);

    expect(request.user).toBeUndefined();
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
    // TC-52-10: no token, so nothing to provision — a @Public() route never reaches the database.
    expect(identity.resolveUserId).not.toHaveBeenCalled();
  });

  it('still requires a token when the handler is not @Public()', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const { context } = contextWith(undefined);

    await expectUnauthenticated(guard.canActivate(context), ErrorCode.UNAUTHENTICATED);
  });
});
