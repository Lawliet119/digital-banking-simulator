import request from 'supertest';
import { ErrorCode } from '../src/common/errors/error-code.enum';
import { ROLES } from '../src/modules/identity';
import { createDevTokenIssuer } from './support/dev-tokens';
import { startLocalAuthApp, type LocalAuthApp } from './support/local-auth-app';

// DBS-53: the whole HTTP stack in AUTH_MODE=local. The keys are made in memory by the same helper
// the other e2e suites can use; JwtAuthGuard, RolesGuard and the signature checks are the real
// ones, only IdentityService (the `users` table) is replaced.
describe('Dev tokens over HTTP in AUTH_MODE=local (e2e)', () => {
  let ctx: LocalAuthApp;

  beforeAll(async () => {
    ctx = await startLocalAuthApp();
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

  const MATRIX = ROLES.flatMap(caller => ROLES.map(target => [caller, target] as const));

  it.each(MATRIX)('TC-53-29 a dev token for %s calling the %s endpoint', async (caller, target) => {
    const token = await ctx.issuer.token(caller);

    const res = await get(`/v1/sample/${target}`, token);

    if (caller === target) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ handler: target });
      expect(ctx.calls.count(target)).toBe(1);
    } else {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ status: 403, errorCode: ErrorCode.FORBIDDEN });
      expect(ctx.calls.total()).toBe(0);
    }
  });

  it('TC-53-30 a token with a custom sub, iat and exp reaches the handler unchanged', async () => {
    const now = Math.floor(Date.now() / 1000);
    const iat = now - 120;
    const exp = now + 600;
    const token = await ctx.issuer.token('customer', { sub: 'nguyen-van-an', iat, exp });

    const res = await get('/v1/identity/me', token);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sub: 'nguyen-van-an',
      userId: ctx.userIdFor('nguyen-van-an'),
      groups: ['customer'],
      claims: { iat, exp, 'cognito:groups': ['customer'] },
    });
  });

  it('TC-53-30 the default sub is stable per role, so repeated tokens reuse one user', async () => {
    const first = await get('/v1/identity/me', await ctx.issuer.token('operator'));
    const second = await get('/v1/identity/me', await ctx.issuer.token('operator'));
    expect(first.body).toMatchObject({ sub: 'dev-operator' });
    expect((first.body as { userId: string }).userId).toBe(
      (second.body as { userId: string }).userId,
    );
  });

  it('TC-53-31 an expired token is TOKEN_EXPIRED', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await ctx.issuer.token('admin', { iat: now - 7200, exp: now - 3600 });

    const res = await get('/v1/identity/me', token);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errorCode: ErrorCode.TOKEN_EXPIRED });
  });

  it('TC-53-31 a token from a different key pair is UNAUTHENTICATED, even with the same kid', async () => {
    const stranger = await createDevTokenIssuer();
    const forged = await stranger.token('admin');
    const sameKid = await createDevTokenIssuer({ kid: ctx.issuer.kid });

    for (const token of [forged, await sameKid.token('admin')]) {
      const res = await get('/v1/sample/admin', token);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ errorCode: ErrorCode.UNAUTHENTICATED });
    }
    expect(ctx.calls.total()).toBe(0);
  });

  it('TC-53-31 no token is UNAUTHENTICATED', async () => {
    const res = await get('/v1/identity/me');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errorCode: ErrorCode.UNAUTHENTICATED });
  });
});
