import { Logger } from '@nestjs/common';
import request from 'supertest';
import { ErrorCode } from '../src/common/errors/error-code.enum';
import { KID, startRolesApp, type RolesApp } from './support/roles-app';

// Role forgery attempts (threat model T21, DoD #3 of DBS-51). Every token here is really signed
// and goes through the real JwksVerifierService and JwtAuthGuard; the only way to become `admin`
// is a `cognito:groups` claim inside a token whose signature verifies. After every attempt the
// handler counter must still be zero: a forged role that merely "gets a 403" while the handler
// ran would be worse than one that gets a 200.
describe('Role forgery is refused (e2e, security)', () => {
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

  function bearer(req: request.Test, token: string): request.Test {
    return req.set('Authorization', `Bearer ${token}`);
  }

  function expectForbidden(res: request.Response): void {
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errorCode: ErrorCode.FORBIDDEN });
  }

  function expectUnauthenticated(res: request.Response): void {
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errorCode: ErrorCode.UNAUTHENTICATED });
  }

  function base64url(value: object): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  it('TC-51-22 a customer token cannot become admin through headers, body, query or cookie', async () => {
    const token = await ctx.tokenFor([]);
    const claimedHeaders = {
      'X-Role': 'admin',
      'X-Roles': 'admin',
      'X-User-Role': 'admin',
      'X-User-Roles': 'admin',
      'X-Cognito-Groups': 'admin',
      'X-Amzn-Oidc-Groups': 'admin',
      'X-Forwarded-Groups': 'admin',
      'X-Forwarded-User-Roles': 'admin',
      Cookie: 'role=admin; roles=admin; cognito:groups=admin',
    };

    // Built one after the other: supertest opens an ephemeral port when a request is created and
    // closes it when that request ends, so a second request created earlier would hit a closed port.
    const onGet = await bearer(
      request(ctx.server).get('/v1/sample/admin?role=admin&roles=admin'),
      token,
    )
      .set(claimedHeaders)
      .send({ role: 'admin', roles: ['admin'], 'cognito:groups': ['admin'] });
    const onPost = await bearer(request(ctx.server).post('/v1/sample/echo-admin?role=admin'), token)
      .set(claimedHeaders)
      .send({ role: 'admin', roles: ['admin'], 'cognito:groups': ['admin'], userId: 'attacker' });

    expectForbidden(onGet);
    expectForbidden(onPost);
    expect(ctx.calls.total()).toBe(0);
  });

  it('TC-51-22 the same attempt does not change what @CurrentUser reports', async () => {
    const token = await ctx.tokenFor([], { sub: 'sub-of-a-plain-customer' });

    const res = await bearer(request(ctx.server).get('/v1/sample/whoami?role=admin'), token)
      .set({ 'X-Role': 'admin', 'X-Cognito-Groups': 'admin', Cookie: 'role=admin' })
      .send({ roles: ['admin'], userId: 'attacker', sub: 'attacker' })
      .expect(200);

    expect(res.body).toEqual({
      userId: ctx.userIdFor('sub-of-a-plain-customer'),
      sub: 'sub-of-a-plain-customer',
      roles: ['customer'],
    });
  });

  it('TC-51-23 a token whose payload was edited to say admin, with the old signature, is 401', async () => {
    const [header, , signature] = (await ctx.tokenFor([])).split('.');
    const forgedPayload = base64url({
      sub: 'sub-forger',
      iss: 'https://issuer.test',
      client_id: 'test-client',
      token_use: 'access',
      'cognito:groups': ['admin'],
      exp: Math.floor(Date.now() / 1000) + 900,
    });

    const res = await bearer(
      request(ctx.server).get('/v1/sample/admin'),
      `${header}.${forgedPayload}.${signature}`,
    );

    expectUnauthenticated(res);
    expect(ctx.calls.total()).toBe(0);
  });

  it('TC-51-23 a token that claims admin but is signed by a different key is 401', async () => {
    const stranger = await ctx.fixture.generateKey('stranger');
    const token = await ctx.fixture.signWith(KID, stranger.privateKey, {
      sub: 'sub-stranger',
      iss: 'https://issuer.test',
      client_id: 'test-client',
      token_use: 'access',
      'cognito:groups': ['admin'],
    });

    expectUnauthenticated(await bearer(request(ctx.server).get('/v1/sample/admin'), token));
    expect(ctx.calls.total()).toBe(0);
  });

  it('TC-51-23 a token with no signature at all (alg none) is 401', async () => {
    const token = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
      sub: 'sub-none',
      iss: 'https://issuer.test',
      client_id: 'test-client',
      token_use: 'access',
      'cognito:groups': ['admin'],
    })}.`;

    expectUnauthenticated(await bearer(request(ctx.server).get('/v1/sample/admin'), token));
    expect(ctx.calls.total()).toBe(0);
  });

  it('TC-51-23 an ID token that carries the admin group is 401: only access tokens count', async () => {
    const token = await ctx.tokenFor(['admin'], { claims: { token_use: 'id' } });

    expectUnauthenticated(await bearer(request(ctx.server).get('/v1/sample/admin'), token));
    expect(ctx.calls.total()).toBe(0);
  });

  it('TC-51-23 an access token issued to another client is 401, whatever groups it holds', async () => {
    const token = await ctx.tokenFor(['admin'], { claims: { client_id: 'someone-elses-app' } });

    expectUnauthenticated(await bearer(request(ctx.server).get('/v1/sample/admin'), token));
    expect(ctx.calls.total()).toBe(0);
  });

  // A signed token can still carry a cognito:groups claim of the wrong type: JwtAuthGuard only
  // replaces a *missing* claim with []. These go through the real verifier and guard chain, so
  // they prove the whole path and not just rolesFromGroups on its own.
  it.each([
    ['a string', 'admin'],
    ['an array-like object', { '0': 'admin', length: 1 }],
    ['a nested array', [['admin']]],
    ['a trailing space', ['admin ']],
    ['a different case', ['ADMIN']],
    ['an object keyed by the role', { admin: true }],
    ['a prototype key', ['__proto__', 'constructor']],
  ])(
    'TC-51-29 a signed token whose cognito:groups is %s is only a customer',
    async (_label, groups) => {
      const token = await ctx.tokenFor(groups);

      expectForbidden(await bearer(request(ctx.server).get('/v1/sample/admin'), token));
      expectForbidden(await bearer(request(ctx.server).get('/v1/sample/operator'), token));
      expect(ctx.calls.total()).toBe(0);
      const who = await bearer(request(ctx.server).get('/v1/sample/whoami'), token).expect(200);
      expect((who.body as { roles: string[] }).roles).toEqual(['customer']);
    },
  );

  describe('TC-51-31 the denial log on the real app', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    /** Calls made by RolesGuard: the structured object has a `route` field. */
    function denialLines(): Array<Record<string, unknown>> {
      return warn.mock.calls
        .map(call => call[0] as unknown)
        .filter(
          (first): first is Record<string, unknown> =>
            typeof first === 'object' && first !== null && 'route' in first,
        );
    }

    it('writes one line per 403 with the route template, and never the query string or the token', async () => {
      const token = await ctx.tokenFor(['customer'], { sub: 'sub-that-must-not-be-logged' });

      const res = await bearer(
        request(ctx.server).get('/v1/sample/admin?role=admin&x=secret'),
        token,
      );

      expectForbidden(res);
      const lines = denialLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        method: 'GET',
        route: '/v1/sample/admin',
        requiredRoles: ['admin'],
        roles: ['customer'],
      });
      const everything = JSON.stringify(warn.mock.calls);
      for (const forbidden of [
        'secret',
        'x=',
        'role=admin',
        token,
        'sub-that-must-not-be-logged',
      ]) {
        expect(everything).not.toContain(forbidden);
      }
    });

    it('writes nothing for an allowed request or for a 401', async () => {
      const token = await ctx.tokenFor(['admin']);

      await bearer(request(ctx.server).get('/v1/sample/admin'), token).expect(200);
      await request(ctx.server).get('/v1/sample/admin').expect(401);

      expect(denialLines()).toHaveLength(0);
    });
  });

  // BL-132: the guard hands every 403 to the audit port. The row itself (action, target, reason,
  // one row per 403) is proved against PostgreSQL in test/db/auth-attacks.db-spec.ts.
  describe('TC-51-33 the audit hand-over on the real app (BL-132)', () => {
    beforeEach(() => {
      ctx.denials.denials.length = 0;
      ctx.denials.failure = undefined;
    });

    it('hands over exactly one denial per 403, with the user, the derived roles, the route template and the response correlationId', async () => {
      const token = await ctx.tokenFor(['customer'], { sub: 'sub-denial-owner' });

      const res = await bearer(
        request(ctx.server).get('/v1/sample/admin?role=admin&x=secret'),
        token,
      );

      expectForbidden(res);
      expect(ctx.denials.denials).toEqual([
        {
          userId: ctx.userIdFor('sub-denial-owner'),
          roles: ['customer'],
          method: 'GET',
          route: '/v1/sample/admin',
          correlationId: res.headers['x-correlation-id'],
        },
      ]);
      expect(JSON.stringify(ctx.denials.denials)).not.toContain('secret');
    });

    it('hands over nothing for an allowed request or a 401', async () => {
      const token = await ctx.tokenFor(['admin']);

      await bearer(request(ctx.server).get('/v1/sample/admin'), token).expect(200);
      await request(ctx.server).get('/v1/sample/admin').expect(401);

      expect(ctx.denials.denials).toHaveLength(0);
    });

    it('answers 500, not a bare 403, when the denial cannot be recorded, and still never runs the handler', async () => {
      ctx.denials.failure = new Error('connection terminated');
      const token = await ctx.tokenFor(['customer']);

      const res = await bearer(request(ctx.server).get('/v1/sample/admin'), token);

      expect(res.status).toBe(500);
      expect(res.body).not.toMatchObject({ errorCode: ErrorCode.FORBIDDEN });
      expect(JSON.stringify(res.body)).not.toContain('connection terminated');
      expect(ctx.calls.total()).toBe(0);
    });
  });
});
