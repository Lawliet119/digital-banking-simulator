/**
 * Manual smoke script for DBS-52 (a `users` row is created at the first valid token).
 *
 * Boots a real Nest HTTP app with IdentityModule + DatabaseModule against the PostgreSQL named by
 * DATABASE_URL, with an in-memory JWKS (no Cognito). After every step it counts the rows of
 * `users` through a separate connection, so the effect of each step on the table is visible
 * without a pause. The steps are `docs/features/DBS-52-users-upsert-first-token.md` §5.
 *
 * Run from `backend/`, on a database that is migrated and, for `main`, empty (see §5):
 *   DATABASE_URL=... npx ts-node -r tsconfig-paths/register src/scripts/manual-smoke.dbs52.ts main
 *   ... manual-smoke.dbs52.ts rerun    (a new process: new RSA key, empty cache)
 *   ... manual-smoke.dbs52.ts outage   (asks you to stop and start PostgreSQL; waits for Enter)
 *
 * Every `sub` is fixed and printed, so a rerun on the same database gives the same answers.
 * Kept in the repository, like manual-smoke.dbs50.ts, so the manual test stays reproducible.
 */
import { createInterface } from 'node:readline/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { DataSource } from 'typeorm';
import { configureHttpApp } from '../app.setup';
import { appConfig, databaseConfig } from '../config';
import { authConfig } from '../config/auth.config';
import { DatabaseModule } from '../database/database.module';
import { IdentityModule } from '../modules/identity';
import { newDevKeyPair } from './dev-auth';

const ISSUER = 'https://issuer.manual-smoke.test';
const CLIENT_ID = 'manual-smoke-client';
const KID = 'manual-smoke-dbs52';

/** Fixed Cognito-shaped subs. The names are labels for the reader only: they are never put in a
 * token or in the database (the schema keeps `cognito_sub` and nothing personal). */
const SUBS = {
  khachLan: '5b0d7c1e-3f4a-4c8e-9d2b-7a1e6f0c9a42',
  operator: '8d1f2a60-4b7c-4e19-a5d3-0c9b6e2f7a11',
  auditor: '3e6c9b72-1a58-4d04-8f2e-5b7a0d4c1e93',
  admin: '9a4b7e15-6c2d-4f83-b0a1-2e8d5c3f6b07',
  burst: 'c2f8d605-7e1a-4b39-9c4d-6a0e3b5f8d21',
  outage: 'e7a3c914-2b6f-4d58-a1e0-4c9d7b2a6f35',
} as const;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

@Global()
@Module({})
class ManualSmokeConfigModule {
  static forRoot(databaseUrl: string, jwksUri: string): DynamicModule {
    const providers = [
      {
        provide: authConfig.KEY,
        useValue: {
          cognito: {
            userPoolId: 'manual-smoke-pool',
            clientId: CLIENT_ID,
            issuer: ISSUER,
            jwksUri,
            jwksCooldownMs: 60_000,
          },
          accessTokenTtlSeconds: 900,
        },
      },
      {
        provide: databaseConfig.KEY,
        useValue: {
          url: databaseUrl,
          poolMax: 10,
          ssl: false,
          sslCaPath: undefined,
          lockTimeoutMs: 2000,
          statementTimeoutMs: 5000,
          idleInTransactionTimeoutMs: 10_000,
        },
      },
      {
        provide: appConfig.KEY,
        useValue: {
          env: 'development',
          isProduction: false,
          port: 0,
          role: 'api',
          logLevel: 'warn',
          trustProxyHops: 0,
          corsOrigins: [],
        },
      },
    ];
    return {
      module: ManualSmokeConfigModule,
      providers,
      exports: providers.map(p => p.provide),
    };
  }
}

async function startJwks(publicJwk: Record<string, unknown>): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/.well-known/jwks.json`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))),
  };
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set: point it at the migrated manual-test database.');
  }
  return url;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'main';
  if (!['main', 'rerun', 'outage'].includes(mode)) {
    throw new Error(`Unknown mode "${mode}": use main, rerun or outage.`);
  }
  const databaseUrl = requireDatabaseUrl();

  // A key generated per process via dev-auth: a token from an earlier run no longer verifies
  // (M-52-07 signs a new token with the same sub for exactly that reason).
  const { privateKey, publicJwk: devPublicJwk } = await newDevKeyPair();
  const publicJwk = { ...devPublicJwk, kid: KID };
  const jwks = await startJwks(publicJwk);

  // Counts and reads through a connection of its own, never through the app under test.
  const probe = await new DataSource({ type: 'postgres', url: databaseUrl }).initialize();
  const count = async (): Promise<number> => {
    const [{ n }] = await probe.query<{ n: number }[]>('SELECT count(*)::int AS n FROM users');
    return n;
  };
  const idOf = async (sub: string): Promise<string | null> => {
    const rows = await probe.query<{ id: string }[]>(
      'SELECT id FROM users WHERE cognito_sub = $1',
      [sub],
    );
    return rows[0]?.id ?? null;
  };

  const rootModule: DynamicModule = {
    module: class ManualSmoke52RootModule {},
    imports: [
      ManualSmokeConfigModule.forRoot(databaseUrl, jwks.url),
      DatabaseModule,
      IdentityModule,
    ],
  };
  const app = await NestFactory.create<NestExpressApplication>(rootModule, {
    logger: ['error', 'warn'],
  });
  configureHttpApp(app, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const sign = (
    sub: string,
    claims: Record<string, unknown> = {},
    expSeconds = 900,
    key: KeyLike = privateKey,
  ): Promise<string> =>
    new SignJWT({ sub, iss: ISSUER, client_id: CLIENT_ID, token_use: 'access', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
      .sign(key);

  const callMe = async (token?: string): Promise<Reply> => {
    const res = await fetch(`${base}/v1/identity/me`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const headers = Object.fromEntries(res.headers.entries());
    return { status: res.status, headers, body: await res.json() };
  };

  /** One line per response: enough to read the outcome, never the token. */
  const show = (label: string, reply: Reply): void => {
    const body = reply.body as { userId?: string; errorCode?: string; groups?: string[] };
    const retry = reply.headers['retry-after']
      ? ` retry-after=${String(reply.headers['retry-after'])}`
      : '';
    console.log(
      `${label} -> ${reply.status}${body.errorCode ? ` ${body.errorCode}` : ''}` +
        `${body.userId ? ` userId=${body.userId}` : ''}${body.groups ? ` groups=${JSON.stringify(body.groups)}` : ''}${retry}`,
    );
  };
  const step = async (title: string, run: () => Promise<void>): Promise<void> => {
    console.log(`\n--- ${title} ---`);
    await run();
    console.log(`users rows now: ${await count()}`);
  };

  console.log(`DBS-52 manual smoke, mode=${mode}, app at ${base}`);
  console.log(`users rows at start (N0): ${await count()}`);

  if (mode === 'main') {
    await step('M-52-02: first token of a self-registered customer (no group)', async () => {
      show(`sub ${SUBS.khachLan} (customer, no group)`, await callMe(await sign(SUBS.khachLan)));
      console.log(`row in DB: id=${await idOf(SUBS.khachLan)}`);
    });

    await step('M-52-03: the same token three more times', async () => {
      const token = await sign(SUBS.khachLan);
      for (let i = 1; i <= 3; i++) show(`call ${i}`, await callMe(token));
    });

    await step('M-52-04: operator, auditor, admin (one sub each)', async () => {
      for (const role of ['operator', 'auditor', 'admin'] as const) {
        show(
          `${role} ${SUBS[role]}`,
          await callMe(await sign(SUBS[role], { 'cognito:groups': [role] })),
        );
      }
    });

    await step('M-52-05: 20 parallel requests for one new sub', async () => {
      const token = await sign(SUBS.burst);
      const replies = await Promise.all(Array.from({ length: 20 }, () => callMe(token)));
      const statuses = replies.map(r => r.status);
      const ids = new Set(replies.map(r => (r.body as { userId?: string }).userId));
      console.log(`statuses: ${JSON.stringify(statuses)}`);
      console.log(`distinct userIds: ${ids.size}; row in DB: id=${await idOf(SUBS.burst)}`);
    });

    await step('M-52-06: foreign key, expired token, no token', async () => {
      const other = await generateKeyPair('RS256');
      show(
        'signed with an unknown key',
        await callMe(await sign(SUBS.outage, {}, 900, other.privateKey)),
      );
      show('expired token', await callMe(await sign(SUBS.outage, {}, -60)));
      show('no Authorization header', await callMe());
      console.log(`row for ${SUBS.outage} (must be none): ${await idOf(SUBS.outage)}`);
    });
  }

  if (mode === 'rerun') {
    await step('M-52-07: new process, new key, empty cache, same sub as M-52-02', async () => {
      show(`sub ${SUBS.khachLan}`, await callMe(await sign(SUBS.khachLan)));
      console.log(`row in DB: id=${await idOf(SUBS.khachLan)}`);
    });
  }

  if (mode === 'outage') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const token = await sign(SUBS.outage);
    console.log('\n--- M-52-08: PostgreSQL stopped ---');
    await rl.question(
      '\nStop PostgreSQL now (docker compose stop postgres), wait 35 s, then press Enter... ',
    );
    show(`sub ${SUBS.outage} while PostgreSQL is down`, await callMe(token));

    console.log('\n--- M-52-09: PostgreSQL started again ---');
    await rl.question(
      '\nStart PostgreSQL (docker compose start postgres), wait until healthy, then press Enter... ',
    );
    rl.close();
    show(`sub ${SUBS.outage} after recovery`, await callMe(token));
    console.log(`row in DB: id=${await idOf(SUBS.outage)}`);
    console.log(`users rows now: ${await count()}`);
  }

  await app.close();
  await jwks.close();
  await probe.destroy();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
