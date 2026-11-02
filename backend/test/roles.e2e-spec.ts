import request from 'supertest';
import { ErrorCode } from '../src/common/errors/error-code.enum';
import { ROLES } from '../src/modules/identity';
import { startRolesApp, type RolesApp } from './support/roles-app';

// The sample controllers exist only in test/support/roles-sample.module.ts. Every handler counts
// its calls, so "403" is proved together with "the handler did not run". IdentityService is the
// only replaced provider (no table needed); the JWKS server and the token signatures are real.
describe('Role checks over HTTP (e2e)', () => {
  let ctx: RolesApp;

  beforeAll(async () => {
    ctx = await startRolesApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.calls.reset();
  });

  function get(path: string, token?: string): request.Test {
    const req = request(ctx.server).get(path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  function expectForbidden(res: request.Response): void {
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({
      status: 403,
      title: 'Forbidden',
      errorCode: ErrorCode.FORBIDDEN,
    });
    expect(typeof (res.body as { correlationId?: unknown }).correlationId).toBe('string');
  }

  const MATRIX = ROLES.flatMap(caller => ROLES.map(target => [caller, target] as const));

  it.each(MATRIX)('TC-51-15 a %s token calling the %s endpoint', async (caller, target) => {
    const token = await ctx.tokenFor([caller]);

    const res = await get(`/v1/sample/${target}`, token);

    if (caller === target) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ handler: target });
      expect(ctx.calls.count(target)).toBe(1);
    } else {
      expectForbidden(res);
      // The point of a role check: the handler never ran. admin on the operator endpoint is
      // one of these cells, so it also proves there is no hierarchy.
      expect(ctx.calls.total()).toBe(0);
    }
  });

  it('TC-51-16 an endpoint for operator and admin admits exactly those two', async () => {
    const outcome: Record<string, number> = {};
    for (const role of ROLES) {
      outcome[role] = (await get('/v1/sample/staff', await ctx.tokenFor([role]))).status;
    }

    expect(outcome).toEqual({ customer: 403, operator: 200, auditor: 403, admin: 200 });
    expect(ctx.calls.count('staff')).toBe(2);
  });

  it('TC-51-17 a token with several groups holds every valid role and no other', async () => {
    const token = await ctx.tokenFor(['operator', 'auditor']);

    expect((await get('/v1/sample/operator', token)).status).toBe(200);
    expect((await get('/v1/sample/auditor', token)).status).toBe(200);
    expectForbidden(await get('/v1/sample/admin', token));
    expectForbidden(await get('/v1/sample/customer', token));
  });

  it.each([
    ['no cognito:groups claim at all', undefined],
    ['an empty group list', []],
    ['only unknown groups', ['ops', 'Admin', 'constructor']],
  ])('TC-51-18 a token with %s is a customer (ADR-06)', async (_label, groups) => {
    const token = await ctx.tokenFor(groups);

    expect((await get('/v1/sample/customer', token)).status).toBe(200);
    expectForbidden(await get('/v1/sample/operator', token));
    expectForbidden(await get('/v1/sample/admin', token));
    const who = await get('/v1/sample/whoami', token).expect(200);
    expect((who.body as { roles: string[] }).roles).toEqual(['customer']);
  });

  it('TC-51-21 a class-level @Roles covers its routes, and a method-level one replaces it', async () => {
    const operator = await ctx.tokenFor(['operator']);
    const admin = await ctx.tokenFor(['admin']);

    expect((await get('/v1/sample-class/inherited', operator)).status).toBe(200);
    expectForbidden(await get('/v1/sample-class/inherited', admin));
    expect((await get('/v1/sample-class/admin-only', admin)).status).toBe(200);
    expectForbidden(await get('/v1/sample-class/admin-only', operator));
  });

  it('TC-51-19 JwtAuthGuard runs first: an expired token is TOKEN_EXPIRED, never FORBIDDEN or UNAUTHENTICATED', async () => {
    // If RolesGuard ran first it would find no request.user and answer UNAUTHENTICATED, so this
    // case (unlike "no token", which is 401 UNAUTHENTICATED in either order) tells the orders apart.
    const expired = await ctx.tokenFor(['customer'], { expSeconds: -3600 });

    const res = await get('/v1/sample/admin', expired);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errorCode: ErrorCode.TOKEN_EXPIRED });
    expect(ctx.calls.total()).toBe(0);
  });

  it('TC-51-19 no token and a garbage token are 401 UNAUTHENTICATED on a @Roles route, not 403', async () => {
    for (const res of [
      await get('/v1/sample/operator'),
      await get('/v1/sample/operator', 'not-a-real-jwt'),
    ]) {
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(res.body).toMatchObject({ errorCode: ErrorCode.UNAUTHENTICATED });
    }
    expect(ctx.calls.total()).toBe(0);
  });

  it('TC-51-20 a route with no @Roles admits every role and a no-group token, and refuses no token', async () => {
    for (const groups of [['customer'], ['operator'], ['auditor'], ['admin'], undefined]) {
      expect((await get('/v1/sample/any', await ctx.tokenFor(groups))).status).toBe(200);
    }
    const res = await get('/v1/sample/any');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errorCode: ErrorCode.UNAUTHENTICATED });
    expect(ctx.calls.count('any')).toBe(5);
  });

  it('TC-51-20 a @Public route needs no token', async () => {
    await get('/v1/sample/public').expect(200);

    expect(ctx.calls.count('public')).toBe(1);
  });

  it('TC-51-20 @Public together with @Roles is 401, with no token and even with a valid admin token', async () => {
    // RolesGuard must trust request.user only: JwtAuthGuard skips a @Public route, so nothing sets
    // request.user, and a guard that parsed the Authorization header itself would let this in.
    const noToken = await get('/v1/sample/public-roles');
    const adminToken = await get('/v1/sample/public-roles', await ctx.tokenFor(['admin']));

    for (const res of [noToken, adminToken]) {
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ errorCode: ErrorCode.UNAUTHENTICATED });
    }
    expect(ctx.calls.count('public-roles')).toBe(0);
  });

  it('TC-51-24 @CurrentUser hands the handler exactly userId, sub and roles', async () => {
    const token = await ctx.tokenFor(['operator'], { sub: 'sub-of-an-operator' });

    const res = await get('/v1/sample/whoami', token).expect(200);

    expect(Object.keys(res.body as object).sort()).toEqual(['roles', 'sub', 'userId']);
    expect(res.body).toEqual({
      userId: ctx.userIdFor('sub-of-an-operator'),
      sub: 'sub-of-an-operator',
      roles: ['operator'],
    });
  });

  it('TC-51-25 a 403 body names no role, no group, no claim and no token', async () => {
    for (const [caller, target] of MATRIX) {
      if (caller === target) continue;
      const token = await ctx.tokenFor([caller], { sub: 'sub-that-must-not-leak' });

      const res = await get(`/v1/sample/${target}`, token);

      expectForbidden(res);
      const text = JSON.stringify(res.body);
      for (const forbidden of [...ROLES, 'groups', 'claims', 'sub-that-must-not-leak', token]) {
        expect(text).not.toContain(forbidden);
      }
    }
  });

  it('TC-51-26 OpenAPI shows x-roles and a 403 on routes with @Roles, and no 403 on a route without', async () => {
    const res = await request(ctx.server).get('/docs-json').expect(200);
    const paths = (
      res.body as {
        paths: Record<string, Record<string, Record<string, unknown> & { responses: object }>>;
      }
    ).paths;

    expect(paths['/v1/sample/admin'].get['x-roles']).toEqual(['admin']);
    expect(paths['/v1/sample/admin'].get.responses).toHaveProperty('403');
    expect(paths['/v1/sample/staff'].get['x-roles']).toEqual(['operator', 'admin']);
    expect(paths['/v1/sample/staff'].get.responses).toHaveProperty('403');
    expect(paths['/v1/sample/any'].get).not.toHaveProperty('x-roles');
    expect(paths['/v1/sample/any'].get.responses).not.toHaveProperty('403');
  });
});
