import { ExecutionContext, HttpException, HttpStatus, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@common/errors/error-code.enum';
import type { RequestWithUser } from './jwt-auth.guard';
import type { AuthenticatedUser } from './jwt-claims';
import type { RoleDenial, RoleDenialAudit } from './role-denial-audit';
import { ROLES_KEY, Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';

const USER_ID = '0f6a3d52-8c1b-4e7a-b6d4-2c9e1a7f5b30';
const SUB = 'sub-5b0d7c1e-3f4a-4c8e-9d2b-7a1e6f0c9a42';
const TOKEN_LIKE = 'eyJhbGciOiJSUzI1NiJ9.payload.signature';
const CORRELATION_ID = '7d1c5e0a-2b94-4f6e-8a3d-9c0b1e2f3a4b';

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
    correlationId: CORRELATION_ID,
    user: user(groups),
    ...extras,
  } as unknown as RequestWithUser & Extras;
}

async function caught(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected the guard to throw');
}

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let warn: jest.SpyInstance;
  let recordRoleDenied: jest.MockedFunction<RoleDenialAudit['recordRoleDenied']>;

  beforeEach(() => {
    recordRoleDenied = jest.fn().mockResolvedValue(undefined);
    guard = new RolesGuard(new Reflector(), { recordRoleDenied });
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function expectForbidden(error: HttpException): void {
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({ errorCode: ErrorCode.FORBIDDEN });
  }

  it('TC-51-06 lets a route with no @Roles through, even with no request.user', async () => {
    const request = { method: 'GET', headers: {} } as unknown as RequestWithUser;

    await expect(guard.canActivate(contextFor(Sample, 'open', request))).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(recordRoleDenied).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty list', 'emptyList'],
    ['a string instead of a list', 'notAnArray'],
    ['an unknown role name', 'unknownName'],
    ['a member that is not a string', 'notAString'],
  ])('TC-51-06 fails closed when the metadata is damaged: %s', async (_label, method) => {
    const error = await caught(
      guard.canActivate(contextFor(Sample, method, requestFor(['admin']))),
    );

    expectForbidden(error);
    // A damaged route is still a refusal, so it leaves the same evidence as any other 403.
    expect(recordRoleDenied).toHaveBeenCalledTimes(1);
  });

  it('TC-51-07 lets the request through when a role matches', async () => {
    await expect(
      guard.canActivate(contextFor(Sample, 'operator', requestFor(['operator']))),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(contextFor(Sample, 'staff', requestFor(['admin']))),
    ).resolves.toBe(true);
    await expect(guard.canActivate(contextFor(Sample, 'customer', requestFor([])))).resolves.toBe(
      true,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(recordRoleDenied).not.toHaveBeenCalled();
  });

  it('TC-51-07 answers 403 FORBIDDEN for the wrong role, with a body that names no role', async () => {
    const error = await caught(
      guard.canActivate(contextFor(Sample, 'admin', requestFor(['customer']))),
    );

    expectForbidden(error);
    const body = JSON.stringify(error.getResponse());
    for (const word of ['customer', 'operator', 'auditor', 'admin', 'groups', 'claims']) {
      expect(body).not.toContain(word);
    }
  });

  it('TC-51-07 does not treat admin as operator (no hierarchy)', async () => {
    expectForbidden(
      await caught(guard.canActivate(contextFor(Sample, 'operator', requestFor(['admin'])))),
    );
  });

  it('TC-51-08 a method-level @Roles replaces the class-level one', async () => {
    await expect(
      guard.canActivate(contextFor(ClassLevel, 'inherited', requestFor(['operator']))),
    ).resolves.toBe(true);
    expectForbidden(
      await caught(guard.canActivate(contextFor(ClassLevel, 'inherited', requestFor(['admin'])))),
    );
    await expect(
      guard.canActivate(contextFor(ClassLevel, 'override', requestFor(['admin']))),
    ).resolves.toBe(true);
    expectForbidden(
      await caught(guard.canActivate(contextFor(ClassLevel, 'override', requestFor(['operator'])))),
    );
  });

  it('TC-51-09 answers 401 UNAUTHENTICATED when a @Roles route has no request.user', async () => {
    const request = { method: 'GET', headers: {} } as unknown as RequestWithUser;

    const error = await caught(guard.canActivate(contextFor(Sample, 'admin', request)));

    expect(error.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect(error.getResponse()).toMatchObject({ errorCode: ErrorCode.UNAUTHENTICATED });
    // No identity, so nothing to attribute: a 401 is not a role denial and writes no audit row.
    expect(recordRoleDenied).not.toHaveBeenCalled();
  });

  it('TC-51-10 ignores a role claimed in a header, the body, the query or a cookie', async () => {
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

    expectForbidden(await caught(guard.canActivate(contextFor(Sample, 'admin', request))));
  });

  it('TC-51-10 reads the role from request.user.groups only: a customer token on an admin route', async () => {
    expectForbidden(
      await caught(guard.canActivate(contextFor(Sample, 'admin', requestFor(undefined)))),
    );
    expectForbidden(
      await caught(guard.canActivate(contextFor(Sample, 'admin', requestFor('admin')))),
    );
  });

  describe('denial log (TC-51-30)', () => {
    it('writes exactly one warn line per 403, with the caller roles and the route template', async () => {
      const request = requestFor(['customer'], { method: 'POST' });
      (request as Extras).route = { path: '/v1/sample/admin' };

      await caught(guard.canActivate(contextFor(Sample, 'staff', request)));

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

    it('never writes the token, sub, groups, claims or any query string', async () => {
      const request = requestFor(['customer'], {
        url: '/v1/sample/admin?role=admin&x=secret',
        originalUrl: '/v1/sample/admin?role=admin&x=secret',
        query: { x: 'secret' },
        headers: { authorization: `Bearer ${TOKEN_LIKE}` },
      });
      (request as Extras).route = { path: '/v1/sample/admin' };

      await caught(guard.canActivate(contextFor(Sample, 'admin', request)));

      const written = JSON.stringify(warn.mock.calls);
      for (const forbidden of [TOKEN_LIKE, SUB, 'secret', 'x=', '?', 'groups', 'claims', 'iss']) {
        expect(written).not.toContain(forbidden);
      }
    });

    it('TC-51-31 writes a fixed placeholder when request.route is missing, never the url', async () => {
      const request = requestFor(['customer'], { url: '/v1/sample/admin?x=secret' });
      (request as Extras).route = undefined;

      await caught(guard.canActivate(contextFor(Sample, 'admin', request)));

      const [fields] = warn.mock.calls[0] as [Record<string, unknown>, ...unknown[]];
      expect(fields.route).toBe('(unknown route)');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    });

    it('does not log an allowed request or a 401', async () => {
      await guard.canActivate(contextFor(Sample, 'operator', requestFor(['operator'])));
      await caught(guard.canActivate(contextFor(Sample, 'admin', { method: 'GET', headers: {} })));

      expect(warn).not.toHaveBeenCalled();
    });
  });

  // BL-132: the denial is also an audit_log DENIED row (FR-AUD-02). The guard only hands the
  // facts over; what the row looks like (action, target, reason) belongs to AuditService.
  describe('audit DENIED record (TC-51-33, BL-132)', () => {
    it('hands over exactly one denial per 403: user, derived roles, method, route template, correlationId', async () => {
      const request = requestFor(['operator', 'auditor'], { method: 'POST' });
      (request as Extras).route = { path: '/v1/operator/deposits' };

      expectForbidden(await caught(guard.canActivate(contextFor(Sample, 'admin', request))));

      expect(recordRoleDenied).toHaveBeenCalledTimes(1);
      expect(recordRoleDenied).toHaveBeenCalledWith({
        userId: USER_ID,
        roles: ['operator', 'auditor'],
        method: 'POST',
        route: '/v1/operator/deposits',
        correlationId: CORRELATION_ID,
      } satisfies RoleDenial);
    });

    it('hands over the derived role (customer) for a token with no groups at all', async () => {
      await caught(guard.canActivate(contextFor(Sample, 'admin', requestFor(undefined))));

      expect(recordRoleDenied.mock.calls[0][0].roles).toEqual(['customer']);
    });

    it('records the denial before the 403 is thrown, never from the allowed path', async () => {
      const order: string[] = [];
      recordRoleDenied.mockImplementation(() => {
        order.push('audit');
        return Promise.resolve();
      });

      const error = await caught(
        guard.canActivate(contextFor(Sample, 'admin', requestFor(['customer']))),
      );
      order.push('thrown');

      expectForbidden(error);
      expect(order).toEqual(['audit', 'thrown']);
    });

    it('uses the fixed placeholder for the route when request.route is missing, never the url', async () => {
      const request = requestFor(['customer'], { url: '/v1/sample/admin?x=secret' });
      (request as Extras).route = undefined;

      await caught(guard.canActivate(contextFor(Sample, 'admin', request)));

      expect(recordRoleDenied.mock.calls[0][0].route).toBe('(unknown route)');
      expect(JSON.stringify(recordRoleDenied.mock.calls)).not.toContain('secret');
    });

    it('fails closed when the denial cannot be recorded: the audit error escapes, never a bare 403', async () => {
      const failure = new Error('connection terminated');
      recordRoleDenied.mockRejectedValue(failure);

      await expect(
        guard.canActivate(contextFor(Sample, 'admin', requestFor(['customer']))),
      ).rejects.toBe(failure);
      // The operational log line is written first, so a database outage still leaves a trace.
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the request has no correlationId instead of inventing one', async () => {
      const request = requestFor(['customer'], { correlationId: undefined });

      await expect(guard.canActivate(contextFor(Sample, 'admin', request))).rejects.toThrow(
        /correlationId/,
      );
      expect(recordRoleDenied).not.toHaveBeenCalled();
    });
  });
});
