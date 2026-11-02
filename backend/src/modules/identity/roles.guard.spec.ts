import { ExecutionContext, HttpException, HttpStatus, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@common/errors/error-code.enum';
import type { RequestWithUser } from './jwt-auth.guard';
import type { AuthenticatedUser } from './jwt-claims';
import { ROLES_KEY, Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';

const USER_ID = '0f6a3d52-8c1b-4e7a-b6d4-2c9e1a7f5b30';
const SUB = 'sub-5b0d7c1e-3f4a-4c8e-9d2b-7a1e6f0c9a42';
const TOKEN_LIKE = 'eyJhbGciOiJSUzI1NiJ9.payload.signature';

class Sample {
  @Roles('customer')
  customer(): void {}

  @Roles('operator')
  operator(): void {}

  @Roles('admin')
  admin(): void {}

  @Roles('operator', 'admin')
  staff(): void {}

  open(): void {}

  @SetMetadata(ROLES_KEY, [])
  emptyList(): void {}

  @SetMetadata(ROLES_KEY, 'admin')
  notAnArray(): void {}

  @SetMetadata(ROLES_KEY, ['superuser'])
  unknownName(): void {}

  @SetMetadata(ROLES_KEY, [1])
  notAString(): void {}
}

@Roles('operator')
class ClassLevel {
  inherited(): void {}

  @Roles('admin')
  override(): void {}
}

function user(groups: unknown): AuthenticatedUser {
  return {
    sub: SUB,
    userId: USER_ID,
    groups: groups as string[],
    tokenUse: 'access',
    claims: {
      sub: SUB,
      iss: 'https://issuer.test',
      client_id: 'test-client',
      token_use: 'access',
      exp: 0,
      iat: 0,
      'cognito:groups': groups as string[],
    },
  };
}

type Extras = Partial<Record<string, unknown>>;

function contextFor(target: new () => object, method: string, request: object): ExecutionContext {
  const handler = (target.prototype as Record<string, () => void>)[method];
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => target,
  } as unknown as ExecutionContext;
}

function requestFor(groups: unknown, extras: Extras = {}): RequestWithUser & Extras {
  return {
    method: 'GET',
    headers: {},
    route: { path: '/v1/sample/route' },
    user: user(groups),
    ...extras,
  } as unknown as RequestWithUser & Extras;
}

function caught(fn: () => unknown): HttpException {
  try {
    fn();
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected the guard to throw');
}

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    guard = new RolesGuard(new Reflector());
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function expectForbidden(error: HttpException): void {
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({ errorCode: ErrorCode.FORBIDDEN });
  }

  it('TC-51-06 lets a route with no @Roles through, even with no request.user', () => {
    const request = { method: 'GET', headers: {} } as unknown as RequestWithUser;

    expect(guard.canActivate(contextFor(Sample, 'open', request))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty list', 'emptyList'],
    ['a string instead of a list', 'notAnArray'],
    ['an unknown role name', 'unknownName'],
    ['a member that is not a string', 'notAString'],
  ])('TC-51-06 fails closed when the metadata is damaged: %s', (_label, method) => {
    const error = caught(() =>
      guard.canActivate(contextFor(Sample, method, requestFor(['admin']))),
    );

    expectForbidden(error);
  });

  it('TC-51-07 lets the request through when a role matches', () => {
    expect(guard.canActivate(contextFor(Sample, 'operator', requestFor(['operator'])))).toBe(true);
    expect(guard.canActivate(contextFor(Sample, 'staff', requestFor(['admin'])))).toBe(true);
    expect(guard.canActivate(contextFor(Sample, 'customer', requestFor([])))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('TC-51-07 answers 403 FORBIDDEN for the wrong role, with a body that names no role', () => {
    const error = caught(() =>
      guard.canActivate(contextFor(Sample, 'admin', requestFor(['customer']))),
    );

    expectForbidden(error);
    const body = JSON.stringify(error.getResponse());
    for (const word of ['customer', 'operator', 'auditor', 'admin', 'groups', 'claims']) {
      expect(body).not.toContain(word);
    }
  });

  it('TC-51-07 does not treat admin as operator (no hierarchy)', () => {
    expectForbidden(
      caught(() => guard.canActivate(contextFor(Sample, 'operator', requestFor(['admin'])))),
    );
  });

  it('TC-51-08 a method-level @Roles replaces the class-level one', () => {
    expect(guard.canActivate(contextFor(ClassLevel, 'inherited', requestFor(['operator'])))).toBe(
      true,
    );
    expectForbidden(
      caught(() => guard.canActivate(contextFor(ClassLevel, 'inherited', requestFor(['admin'])))),
    );
    expect(guard.canActivate(contextFor(ClassLevel, 'override', requestFor(['admin'])))).toBe(true);
    expectForbidden(
      caught(() => guard.canActivate(contextFor(ClassLevel, 'override', requestFor(['operator'])))),
    );
  });

  it('TC-51-09 answers 401 UNAUTHENTICATED when a @Roles route has no request.user', () => {
    const request = { method: 'GET', headers: {} } as unknown as RequestWithUser;

    const error = caught(() => guard.canActivate(contextFor(Sample, 'admin', request)));

    expect(error.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect(error.getResponse()).toMatchObject({ errorCode: ErrorCode.UNAUTHENTICATED });
  });

  it('TC-51-10 ignores a role claimed in a header, the body, the query or a cookie', () => {
    const request = requestFor([], {
      headers: {
        'x-role': 'admin',
        'x-user-roles': 'admin',
        'x-cognito-groups': 'admin',
        'x-forwarded-groups': 'admin',
        cookie: 'role=admin',
      },
      body: { role: 'admin', roles: ['admin'], 'cognito:groups': ['admin'] },
      query: { role: 'admin' },
      cookies: { role: 'admin' },
    });

    expectForbidden(caught(() => guard.canActivate(contextFor(Sample, 'admin', request))));
  });

  it('TC-51-10 reads the role from request.user.groups only: a customer token on an admin route', () => {
    expectForbidden(
      caught(() => guard.canActivate(contextFor(Sample, 'admin', requestFor(undefined)))),
    );
    expectForbidden(
      caught(() => guard.canActivate(contextFor(Sample, 'admin', requestFor('admin')))),
    );
  });

  describe('denial log (TC-51-30)', () => {
    it('writes exactly one warn line per 403, with the caller roles and the route template', () => {
      const request = requestFor(['customer'], { method: 'POST' });
      (request as Extras).route = { path: '/v1/sample/admin' };

      caught(() => guard.canActivate(contextFor(Sample, 'staff', request)));

      expect(warn).toHaveBeenCalledTimes(1);
      const [fields] = warn.mock.calls[0] as [Record<string, unknown>, ...unknown[]];
      expect(fields).toEqual({
        userId: USER_ID,
        method: 'POST',
        route: '/v1/sample/admin',
        requiredRoles: ['operator', 'admin'],
        roles: ['customer'],
      });
    });

    it('never writes the token, sub, groups, claims or any query string', () => {
      const request = requestFor(['customer'], {
        url: '/v1/sample/admin?role=admin&x=secret',
        originalUrl: '/v1/sample/admin?role=admin&x=secret',
        query: { x: 'secret' },
        headers: { authorization: `Bearer ${TOKEN_LIKE}` },
      });
      (request as Extras).route = { path: '/v1/sample/admin' };

      caught(() => guard.canActivate(contextFor(Sample, 'admin', request)));

      const written = JSON.stringify(warn.mock.calls);
      for (const forbidden of [TOKEN_LIKE, SUB, 'secret', 'x=', '?', 'groups', 'claims', 'iss']) {
        expect(written).not.toContain(forbidden);
      }
    });

    it('TC-51-31 writes a fixed placeholder when request.route is missing, never the url', () => {
      const request = requestFor(['customer'], { url: '/v1/sample/admin?x=secret' });
      (request as Extras).route = undefined;

      caught(() => guard.canActivate(contextFor(Sample, 'admin', request)));

      const [fields] = warn.mock.calls[0] as [Record<string, unknown>, ...unknown[]];
      expect(fields.route).toBe('(unknown route)');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    });

    it('does not log an allowed request or a 401', () => {
      guard.canActivate(contextFor(Sample, 'operator', requestFor(['operator'])));
      caught(() => guard.canActivate(contextFor(Sample, 'admin', { method: 'GET', headers: {} })));

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
