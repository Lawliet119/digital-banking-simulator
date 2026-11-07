import { randomUUID } from 'node:crypto';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type request from 'supertest';
import { configureHttpApp, setupSwagger } from '../../src/app.setup';
import { authConfig } from '../../src/config/auth.config';
import {
  IdentityModule,
  IdentityService,
  JwtAuthGuard,
  RolesGuard,
} from '../../src/modules/identity';
import { startJwksFixture, type JwksFixture } from './jwks-fixture';
import { calls, RolesSampleModule } from './roles-sample.module';

export const ISSUER = 'https://issuer.test';
export const CLIENT_ID = 'test-client';
export const KID = 'kid-roles-e2e';

/**
 * Supplies a fake `authConfig.KEY` without running the real factory (which validates the whole
 * environment, DATABASE_URL included). `@Global()` so IdentityModule, a sibling import, can still
 * inject it. Same technique as identity.e2e-spec.ts.
 */
@Global()
@Module({})
class TestAuthConfigModule {
  static forRoot(value: unknown): DynamicModule {
    return {
      module: TestAuthConfigModule,
      providers: [{ provide: authConfig.KEY, useValue: value }],
      exports: [authConfig.KEY],
    };
  }
}

export interface TokenOptions {
  /** Cognito `sub`. Defaults to a new one per call. */
  sub?: string;
  /** Claims merged last, so a test can override anything (`token_use`, `client_id`, ...). */
  claims?: Record<string, unknown>;
  /** Seconds until `exp`. Negative signs an already expired token (the verifier allows 5 s). */
  expSeconds?: number;
}

export interface RolesApp {
  server: Parameters<typeof request>[0];
  app: NestExpressApplication;
  fixture: JwksFixture;
  calls: typeof calls;
  /** A really signed access token. `groups` undefined leaves out the `cognito:groups` claim. */
  tokenFor(groups: unknown, options?: TokenOptions): Promise<string>;
  /** The `users.id` the fake IdentityService gives to this `sub` (stable for the whole run). */
  userIdFor(sub: string): string;
  close(): Promise<void>;
}

/**
 * The HTTP app of the DBS-51 role tests: the real IdentityModule (so the real JwtAuthGuard,
 * JWKS verification and signature checks), the sample controllers, and the same two APP_GUARDs
 * app.module.ts registers, in the same order. Only IdentityService is replaced, so no table is
 * needed. The real AppModule is checked separately in roles-app.e2e-spec.ts.
 */
export async function startRolesApp(): Promise<RolesApp> {
  const fixture = await startJwksFixture();
  const key = await fixture.generateKey(KID);
  fixture.rotate(KID, key.publicJwk);

  const userIds = new Map<string, string>();
  const userIdFor = (sub: string): string => {
    let id = userIds.get(sub);
    if (!id) {
      id = randomUUID();
      userIds.set(sub, id);
    }
    return id;
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      TestAuthConfigModule.forRoot({
        cognito: {
          userPoolId: 'pool-test',
          clientId: CLIENT_ID,
          issuer: ISSUER,
          jwksUri: fixture.url,
          jwksCooldownMs: 200,
        },
        accessTokenTtlSeconds: 900,
      }),
      IdentityModule,
      RolesSampleModule,
    ],
    providers: [
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
    ],
  })
    .overrideProvider(IdentityService)
    .useValue({
      resolveUserId: (sub: string) => Promise.resolve(userIdFor(sub)),
      sessionsRevokedAt: () => Promise.resolve(null),
    })
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureHttpApp(app, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
  setupSwagger(app);
  await app.init();

  let counter = 0;
  return {
    server: app.getHttpServer() as Parameters<typeof request>[0],
    app,
    fixture,
    calls,
    async tokenFor(groups, options = {}) {
      counter += 1;
      const claims: Record<string, unknown> = {
        sub: options.sub ?? `sub-roles-e2e-${counter}`,
        iss: ISSUER,
        client_id: CLIENT_ID,
        token_use: 'access',
        ...(groups === undefined ? {} : { 'cognito:groups': groups }),
        ...options.claims,
      };
      return fixture.signWith(KID, key.privateKey, claims, options.expSeconds);
    },
    userIdFor,
    async close() {
      await app.close();
      await fixture.close();
    },
  };
}
