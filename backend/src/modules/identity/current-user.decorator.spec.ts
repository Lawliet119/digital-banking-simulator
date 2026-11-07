import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ErrorCode } from '@common/errors/error-code.enum';
import type { RequestWithUser } from './jwt-auth.guard';
import type { AuthenticatedUser } from './jwt-claims';
import { CurrentUser, currentUserFromContext } from './current-user.decorator';

const USER_ID = '0f6a3d52-8c1b-4e7a-b6d4-2c9e1a7f5b30';
const SUB = '5b0d7c1e-3f4a-4c8e-9d2b-7a1e6f0c9a42';

function userWith(groups: unknown): AuthenticatedUser {
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
    },
  };
}

function contextFor(request: object): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('currentUserFromContext', () => {
  it('TC-51-11 returns exactly userId, sub and roles', () => {
    const request = { user: userWith(['operator']) } as unknown as RequestWithUser;

    const current = currentUserFromContext(contextFor(request));

    expect(current).toEqual({ userId: USER_ID, sub: SUB, roles: ['operator'] });
    expect(Object.keys(current).sort()).toEqual(['roles', 'sub', 'userId']);
  });

  it('TC-51-11 never exposes the claims or the raw groups', () => {
    const request = { user: userWith(['admin', 'xyz']) } as unknown as RequestWithUser;

    const current = currentUserFromContext(contextFor(request)) as unknown as Record<
      string,
      unknown
    >;

    expect(current).not.toHaveProperty('claims');
    expect(current).not.toHaveProperty('groups');
    expect(current).not.toHaveProperty('tokenUse');
    expect(current.roles).toEqual(['admin']);
  });

  it('TC-51-11 derives roles from groups: none or unknown means customer, several are all kept', () => {
    const rolesOf = (groups: unknown) =>
      currentUserFromContext(contextFor({ user: userWith(groups) })).roles;

    expect(rolesOf([])).toEqual(['customer']);
    expect(rolesOf(['xyz'])).toEqual(['customer']);
    expect(rolesOf('admin')).toEqual(['customer']);
    expect(rolesOf(['auditor', 'operator'])).toEqual(['operator', 'auditor']);
  });

  it('TC-51-11 returns a new object every call, so a handler cannot change what the next one sees', () => {
    const request = { user: userWith(['operator']) };

    const first = currentUserFromContext(contextFor(request));
    first.roles.push('admin');
    (first as { userId: string }).userId = 'changed';

    expect(currentUserFromContext(contextFor(request))).toEqual({
      userId: USER_ID,
      sub: SUB,
      roles: ['operator'],
    });
    expect(request.user.groups).toEqual(['operator']);
  });

  it('TC-51-12 ignores a role claimed in a header, the body, the query or a cookie', () => {
    const request = {
      user: userWith([]),
      headers: { 'x-role': 'admin', 'x-cognito-groups': 'admin' },
      body: { role: 'admin', roles: ['admin'], userId: 'attacker', sub: 'attacker' },
      query: { role: 'admin' },
      cookies: { role: 'admin' },
    };

    expect(currentUserFromContext(contextFor(request))).toEqual({
      userId: USER_ID,
      sub: SUB,
      roles: ['customer'],
    });
  });

  it('TC-51-12 answers 401 UNAUTHENTICATED when there is no request.user (a @Public route)', () => {
    let thrown: unknown;
    try {
      currentUserFromContext(contextFor({ headers: {} }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
      response: expect.objectContaining({ errorCode: ErrorCode.UNAUTHENTICATED }),
    });
  });
});

describe('CurrentUser decorator', () => {
  it('TC-51-11 is a parameter decorator that hands the handler the value of currentUserFromContext', () => {
    class Probe {
      handler(@CurrentUser() _who: unknown): void {}
    }
    const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handler') as Record<
      string,
      { factory: (data: unknown, ctx: ExecutionContext) => unknown }
    >;
    const [entry] = Object.values(metadata);
    const request = { user: userWith(['auditor']) };

    expect(entry.factory(undefined, contextFor(request))).toEqual({
      userId: USER_ID,
      sub: SUB,
      roles: ['auditor'],
    });
  });
});
