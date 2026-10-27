import { Global, Module, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureHttpApp } from '../src/app.setup';
import { authConfig } from '../src/config/auth.config';
import { ErrorCode } from '../src/common/errors/error-code.enum';
import { IdentityModule } from '../src/modules/identity';
import { startJwksFixture, type JwksFixture } from './support/jwks-fixture';

/**
 * Supplies a fake `authConfig.KEY` without ever calling the real factory (which would run
 * `validateEnv` against the whole schema, including unrelated required vars like DATABASE_URL).
 * `@Global()` so IdentityModule — a sibling import, not a child of this module — can still
 * inject it; the real app gets the same reach via `ConfigModule`'s own `@Global()`.
 */
@Global()
@Module({})
class TestAuthConfigModule {
  static forRoot(value: unknown) {
    return {
      module: TestAuthConfigModule,
      providers: [{ provide: authConfig.KEY, useValue: value }],
      exports: [authConfig.KEY],
    };
  }
}

const ISSUER = 'https://issuer.test';
const CLIENT_ID = 'test-client';
const COOLDOWN_MS = 200;

function baseClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'user-123',
    iss: ISSUER,
    client_id: CLIENT_ID,
    token_use: 'access',
    'cognito:groups': ['operator'],
    ...overrides,
  };
}

describe('GET /v1/identity/me (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let fixture: JwksFixture;

  beforeAll(async () => {
    fixture = await startJwksFixture();
    const moduleRef = await Test.createTestingModule({
      imports: [
        TestAuthConfigModule.forRoot({
          cognito: {
            userPoolId: 'pool-test',
            clientId: CLIENT_ID,
            issuer: ISSUER,
            jwksUri: fixture.url,
            jwksCooldownMs: COOLDOWN_MS,
          },
          accessTokenTtlSeconds: 900,
        }),
        IdentityModule,
      ],
    }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(nest, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
    await nest.init();
    app = nest;
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
    await fixture.close();
  });

  it('answers 401 UNAUTHENTICATED with no Authorization header', async () => {
    const res = await request(server).get('/v1/identity/me').expect(401);

    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body.errorCode).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it('answers 401 UNAUTHENTICATED for a garbage bearer token', async () => {
    const res = await request(server)
      .get('/v1/identity/me')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .expect(401);

    expect(res.body.errorCode).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it('answers 200 with the verified claims for a valid token', async () => {
    const key = await fixture.generateKey('kid-e2e-1');
    fixture.rotate('kid-e2e-1', key.publicJwk);
    const token = await fixture.signWith('kid-e2e-1', key.privateKey, baseClaims());

    const res = await request(server)
      .get('/v1/identity/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toMatchObject({
      sub: 'user-123',
      groups: ['operator'],
      tokenUse: 'access',
    });
  });

  it('answers 401 UNAUTHENTICATED when token_use is not "access"', async () => {
    // Past the JWKS cooldown since the previous test's fetch, so this rotated key is actually
    // looked up (and the manual token_use check, not a stale "unknown kid", is what rejects it).
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS + 50));
    const key = await fixture.generateKey('kid-e2e-2');
    fixture.rotate('kid-e2e-2', key.publicJwk);
    const token = await fixture.signWith(
      'kid-e2e-2',
      key.privateKey,
      baseClaims({ token_use: 'id' }),
    );

    const res = await request(server)
      .get('/v1/identity/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body.errorCode).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it('answers 401 UNAUTHENTICATED for the wrong client_id', async () => {
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS + 50));
    const key = await fixture.generateKey('kid-e2e-3');
    fixture.rotate('kid-e2e-3', key.publicJwk);
    const token = await fixture.signWith(
      'kid-e2e-3',
      key.privateKey,
      baseClaims({ client_id: 'someone-else' }),
    );

    const res = await request(server)
      .get('/v1/identity/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body.errorCode).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it('answers 401 TOKEN_EXPIRED for an expired token', async () => {
    // Must be past the cooldown: this key has to actually be found and its signature verified
    // for the guard to ever reach the `exp` check.
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS + 50));
    const key = await fixture.generateKey('kid-e2e-4');
    fixture.rotate('kid-e2e-4', key.publicJwk);
    const token = await fixture.signWith('kid-e2e-4', key.privateKey, baseClaims(), -10);

    const res = await request(server)
      .get('/v1/identity/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body.errorCode).toBe(ErrorCode.TOKEN_EXPIRED);
  });

  it('refetches the JWKS on key rotation, end to end, without restarting the app', async () => {
    // The JwksVerifierService instance is shared across this whole describe block (one compiled
    // app), so its cache may still be "fresh" from a previous test's fetch; wait out the cooldown
    // so this rotated key is actually looked up instead of rejected as a merely-stale kid.
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS + 50));
    const keyA = await fixture.generateKey('kid-rotation-a');
    fixture.rotate('kid-rotation-a', keyA.publicJwk);
    const tokenA = await fixture.signWith('kid-rotation-a', keyA.privateKey, baseClaims());
    await request(server)
      .get('/v1/identity/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    // Past the cooldown: rotating to a new key is picked up transparently.
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS + 50));
    const keyB = await fixture.generateKey('kid-rotation-b');
    fixture.rotate('kid-rotation-b', keyB.publicJwk);
    const tokenB = await fixture.signWith('kid-rotation-b', keyB.privateKey, baseClaims());

    await request(server)
      .get('/v1/identity/me')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
  });
});
