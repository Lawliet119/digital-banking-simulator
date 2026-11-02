import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type request from 'supertest';
import { configureHttpApp } from '../../src/app.setup';
import { LOCAL_CLIENT_ID, LOCAL_ISSUER } from '../../src/config/auth-local';
import { authConfig } from '../../src/config/auth.config';
import {
  IdentityModule,
  IdentityService,
  JwtAuthGuard,
  RolesGuard,
} from '../../src/modules/identity';
import { createDevTokenIssuer, type DevTokenIssuer } from './dev-tokens';
import { calls, RolesSampleModule } from './roles-sample.module';

/** Same technique as roles-app.ts: a fake `authConfig.KEY`, global so IdentityModule can inject it. */
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

export interface LocalAuthApp {
  server: Parameters<typeof request>[0];
  app: NestExpressApplication;
  calls: typeof calls;
  issuer: DevTokenIssuer;
  /** The `users.id` the fake IdentityService gives to this `sub` (stable for the whole run). */
  userIdFor(sub: string): string;
  close(): Promise<void>;
}

/**
 * The HTTP app of the DBS-53 tests, in AUTH_MODE=local: the real IdentityModule, so the real
 * JwtAuthGuard and RolesGuard, and a verifier that reads its keys from a file exactly as it does
 * under `AUTH_LOCAL_JWKS_PATH`. The file is written to a temp directory from the issuer's
 * in-memory key; no network and no Cognito. Only IdentityService is replaced, so no table is
 * needed.
 */
export async function startLocalAuthApp(): Promise<LocalAuthApp> {
  const issuer = await createDevTokenIssuer();
  const dir = mkdtempSync(join(tmpdir(), 'dbs-53-e2e-'));
  const jwksPath = join(dir, 'jwks.json');
  writeFileSync(jwksPath, JSON.stringify(issuer.jwks));

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
        local: { jwksPath },
        cognito: {
          userPoolId: undefined,
          clientId: LOCAL_CLIENT_ID,
          issuer: LOCAL_ISSUER,
          jwksUri: undefined,
          jwksCooldownMs: 60_000,
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
    .useValue({ resolveUserId: (sub: string) => Promise.resolve(userIdFor(sub)) })
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureHttpApp(app, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
  await app.init();

  return {
    server: app.getHttpServer() as Parameters<typeof request>[0],
    app,
    calls,
    issuer,
    userIdFor,
    async close() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
