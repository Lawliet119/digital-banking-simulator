/**
 * Manual smoke script for DBS-50 (JwtAuthGuard + JwksVerifierService). Boots a real Nest HTTP
 * app with ONLY IdentityModule, backed by an in-memory JWKS server (no Cognito, no Docker, no
 * Postgres needed), and prints the response of each step in
 * `docs/features/DBS-50-jwt-auth-guard-jwks.md` §5.
 *
 * DBS-52: the guard now resolves `users.id` through IdentityService, which needs a
 * TransactionService. This script keeps its "no Postgres" property by supplying a fake one that
 * answers every query with a fixed id. NestFactory.create has no overrideProvider, hence a
 * @Global() module instead. The real upsert is exercised by manual-smoke.dbs52.ts.
 *
 * Run (from `backend/`): npx ts-node -r tsconfig-paths/register src/scripts/manual-smoke.dbs50.ts
 * domain-review vòng 2 #2: kept in the repo (not deleted after running) so the manual test in §5
 * stays reproducible, instead of only described in prose.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type JWK, SignJWT } from 'jose';
import { configureHttpApp, setupSwagger } from '../app.setup';
import { authConfig } from '../config/auth.config';
import { TransactionService } from '../database/transaction.service';
import { IdentityModule } from '../modules/identity';
import { newDevKeyPair } from './dev-auth';

const ISSUER = 'https://issuer.manual-smoke.test';
const CLIENT_ID = 'manual-smoke-client';

type JwksKey = JWK & {
  kid: string;
};

async function startFixtureJwks(): Promise<{
  url: string;
  setKeys: (keys: JwksKey[]) => void;
  close: () => Promise<void>;
}> {
  let keys: JwksKey[] = [];
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/.well-known/jwks.json`,
    setKeys: next => {
      keys = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))),
  };
}

/** Supplies a fake `authConfig.KEY` without running the real factory (same pattern as
 * `identity.e2e-spec.ts`'s `TestAuthConfigModule`). */
@Global()
@Module({})
class ManualSmokeAuthConfigModule {
  static forRoot(value: unknown): DynamicModule {
    return {
      module: ManualSmokeAuthConfigModule,
      providers: [{ provide: authConfig.KEY, useValue: value }],
      exports: [authConfig.KEY],
    };
  }
}

/** A TransactionService that never reaches a database: every query answers one fixed user id. */
@Global()
@Module({})
class ManualSmokeFakeTransactionModule {
  static forRoot(): DynamicModule {
    const fake = {
      run: <T>(fn: (manager: { query: () => Promise<{ id: string }[]> }) => Promise<T>) =>
        fn({ query: () => Promise.resolve([{ id: '0f6a3d52-8c1b-4e7a-b6d4-2c9e1a7f5b30' }]) }),
    };
    return {
      module: ManualSmokeFakeTransactionModule,
      providers: [{ provide: TransactionService, useValue: fake }],
      exports: [TransactionService],
    };
  }
}

async function getJsonBody(res: Response): Promise<unknown> {
  return res.json();
}

async function main(): Promise<void> {
  const fixture = await startFixtureJwks();
  const { privateKey, publicJwk } = await newDevKeyPair();
  const kid = publicJwk.kid;

  const rootModule: DynamicModule = {
    module: class ManualSmokeRootModule {},
    imports: [
      ManualSmokeAuthConfigModule.forRoot({
        cognito: {
          userPoolId: 'manual-smoke-pool',
          clientId: CLIENT_ID,
          issuer: ISSUER,
          jwksUri: fixture.url,
          jwksCooldownMs: 60_000,
        },
        accessTokenTtlSeconds: 900,
      }),
      ManualSmokeFakeTransactionModule.forRoot(),
      IdentityModule,
    ],
  };

  const app = await NestFactory.create<NestExpressApplication>(rootModule);
  configureHttpApp(app, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
  setupSwagger(app);
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  console.log(`Manual smoke app listening at ${base} (JWKS fixture at ${fixture.url})\n`);

  const sign = (overrides: Record<string, unknown> = {}, expSeconds = 900): Promise<string> =>
    new SignJWT({
      sub: 'user-123',
      iss: ISSUER,
      client_id: CLIENT_ID,
      token_use: 'access',
      'cognito:groups': ['operator'],
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
      .sign(privateKey);

  console.log('--- M-50-01: GET /v1/identity/me, no Authorization header ---');
  console.log(await getJsonBody(await fetch(`${base}/v1/identity/me`)));

  console.log('\n--- M-50-02: Authorization: Bearer not-a-jwt ---');
  console.log(
    await getJsonBody(
      await fetch(`${base}/v1/identity/me`, { headers: { Authorization: 'Bearer not-a-jwt' } }),
    ),
  );

  fixture.setKeys([{ ...publicJwk }]); // only now does the JWKS endpoint actually serve the key
  console.log('\n--- M-50-03: valid token ---');
  console.log(
    await getJsonBody(
      await fetch(`${base}/v1/identity/me`, {
        headers: { Authorization: `Bearer ${await sign()}` },
      }),
    ),
  );

  console.log('\n--- M-50-04: expired token (exp in the past) ---');
  console.log(
    await getJsonBody(
      await fetch(`${base}/v1/identity/me`, {
        headers: { Authorization: `Bearer ${await sign({}, -10)}` },
      }),
    ),
  );

  console.log('\n--- M-50-05: Swagger bearerAuth scheme (GET /docs-json) ---');
  const doc = (await getJsonBody(await fetch(`${base}/docs-json`))) as {
    components: { securitySchemes: unknown };
    paths: Record<string, { get?: { security?: unknown } }>;
  };
  console.log('components.securitySchemes:', doc.components.securitySchemes);
  console.log('/v1/identity/me security:', doc.paths['/v1/identity/me']?.get?.security);

  await app.close();
  await fixture.close();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
