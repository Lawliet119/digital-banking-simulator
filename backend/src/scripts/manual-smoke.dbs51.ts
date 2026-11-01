/**
 * Manual smoke script for DBS-51 (@Roles, RolesGuard, @CurrentUser).
 *
 * Boots the REAL AppModule (APP_ROLE=api) against the PostgreSQL named by DATABASE_URL, plus a
 * module of sample endpoints defined in this file (nothing is imported from test/: tsconfig has
 * no rootDir, so that would pull test/ into the build). Tokens are really signed with a key made
 * at start-up and served by an in-memory JWKS (there is no Cognito and no auth:dev-token yet).
 * The steps are `docs/features/DBS-51-roles-guard-current-user.md` §5.
 *
 * Run from `backend/`, on a throwaway migrated database (see §5):
 *   DATABASE_URL=... REDIS_URL=redis://localhost:6379 NO_COLOR=1 \
 *     npx ts-node -r tsconfig-paths/register src/scripts/manual-smoke.dbs51.ts main
 *   ... manual-smoke.dbs51.ts outage   (asks you to stop and start PostgreSQL; waits for Enter)
 *
 * Every `sub` of `main` is fixed and printed, so a second run gives the same answers. The `sub`
 * of `outage` is new each run: it must be a user the database has never seen. No token is ever
 * printed. Kept in the repository, like manual-smoke.dbs50.ts and dbs52.ts.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { DataSource } from 'typeorm';
import { Public } from '../common/auth/public.decorator';
import { CurrentUser, Roles, type CurrentUserInfo } from '../modules/identity';

const CLIENT_ID = 'manual-smoke-client';
const KID = 'manual-smoke-dbs51';
const ROLE_NAMES = ['customer', 'operator', 'auditor', 'admin'] as const;

/** Fixed Cognito-shaped subs. The names are labels for the reader only. */
const SUBS = {
  customer: '5b0d7c1e-3f4a-4c8e-9d2b-7a1e6f0c9a42',
  operator: '8d1f2a60-4b7c-4e19-a5d3-0c9b6e2f7a11',
  auditor: '3e6c9b72-1a58-4d04-8f2e-5b7a0d4c1e93',
  admin: '9a4b7e15-6c2d-4f83-b0a1-2e8d5c3f6b07',
  noGroup: 'c2f8d605-7e1a-4b39-9c4d-6a0e3b5f8d21',
  multi: '1f7a3c58-9d24-4e6b-8a05-3b9c6d1e7f42',
  unknownGroup: '6d2e8b14-5a93-4c70-b1f6-8e4a2c7d0b95',
  stringGroups: 'a4c9e271-3b86-4d15-9e07-1f5b8a3c6d20',
  spaceGroup: 'b7e1d493-2c58-4a60-8f19-6d3a0b9e5c71',
  forger: 'd8f3a6b0-1e47-4c92-a5d8-2b7c9e1f4a63',
} as const;

const counts = new Map<string, number>();
const ran = (name: string): { handler: string } => {
  counts.set(name, (counts.get(name) ?? 0) + 1);
  return { handler: name };
};

@Controller('sample')
class SampleController {
  @Get('customer') @Roles('customer') customer() {
    return ran('customer');
  }
  @Get('operator') @Roles('operator') operator() {
    return ran('operator');
  }
  @Get('auditor') @Roles('auditor') auditor() {
    return ran('auditor');
  }
  @Get('admin') @Roles('admin') admin() {
    return ran('admin');
  }
  @Post('echo-admin') @Roles('admin') echoAdmin() {
    return ran('echo-admin');
  }
  /** No @Roles and no @Public: any valid token (decision G1). */
  @Get('any') any() {
    return ran('any');
  }
  /** A mistake a developer could make: never reachable, there is no caller. */
  @Get('public-roles') @Public() @Roles('admin') publicRoles() {
    return ran('public-roles');
  }
  @Get('whoami') whoami(@CurrentUser() who: CurrentUserInfo): CurrentUserInfo {
    return who;
  }
}

@Module({ controllers: [SampleController] })
class SampleModule {}

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
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

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'main';
  if (!['main', 'outage'].includes(mode)) {
    throw new Error(`Unknown mode "${mode}": use main or outage.`);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set: point it at the migrated throwaway database.');
  }
  if (!process.env.REDIS_URL) {
    throw new Error(
      'REDIS_URL is not set: AppModule validates it at start-up (redis://localhost:6379).',
    );
  }

  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  const jwks = await startJwks(publicJwk);

  // AppModule reads its configuration from the environment when it is first imported, so the
  // environment is set first and the import is dynamic (same technique as app-guard.e2e-spec.ts).
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ROLE: 'api',
    COGNITO_USER_POOL_ID: 'manual-smoke-pool',
    COGNITO_CLIENT_ID: CLIENT_ID,
    COGNITO_ISSUER: jwks.url.replace('/.well-known/jwks.json', ''),
  });
  const { AppModule } = await import('../app.module');
  const { configureHttpApp, setupSwagger } = await import('../app.setup');

  // The real AppModule cannot be given extra controllers, so the sample module is merged in by
  // decorating a thin root module that imports both.
  @Module({ imports: [AppModule, SampleModule] })
  class ManualSmokeRootModule {}

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

  const app = await NestFactory.create<NestExpressApplication>(ManualSmokeRootModule, {
    logger: ['error', 'warn'],
  });
  configureHttpApp(app, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
  setupSwagger(app);
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  // The verifier compares `iss` with COGNITO_ISSUER, which is the JWKS server's address.
  const issuer = process.env.COGNITO_ISSUER as string;
  const token = (sub: string, groups?: unknown, expSeconds = 900, key: KeyLike = privateKey) =>
    new SignJWT({
      sub,
      iss: issuer,
      client_id: CLIENT_ID,
      token_use: 'access',
      ...(groups === undefined ? {} : { 'cognito:groups': groups }),
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
      .sign(key);

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    bearer?: string,
    extra: { headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<Reply> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(extra.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra.headers,
      },
      // fetch refuses a body on GET, so a body is only ever sent with POST.
      body: extra.body === undefined ? undefined : JSON.stringify(extra.body),
    });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  };

  /** One line per response, never the token. */
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const show = (label: string, reply: Reply): void => {
    const b = reply.body;
    const errorCode = text(b.errorCode);
    const handler = text(b.handler);
    const userId = text(b.userId);
    const retry = reply.headers['retry-after']
      ? ` retry-after=${reply.headers['retry-after']}`
      : '';
    const type = reply.headers['content-type']?.split(';')[0] ?? '';
    console.log(
      `${label} -> ${reply.status}${errorCode ? ` ${errorCode}` : ''}` +
        `${handler ? ` handler=${handler}` : ''}` +
        `${b.roles ? ` roles=${JSON.stringify(b.roles)}` : ''}` +
        `${userId ? ` userId=${userId}` : ''} [${type}]${retry}`,
    );
  };
  const handlersRun = (): number => [...counts.values()].reduce((a, b) => a + b, 0);
  const step = async (title: string, run: () => Promise<void>): Promise<void> => {
    console.log(`\n--- ${title} ---`);
    await run();
    console.log(`handlers run so far: ${handlersRun()}; users rows: ${await count()}`);
  };

  console.log(`DBS-51 manual smoke, mode=${mode}, app at ${base}`);
  console.log(`users rows at start (N0): ${await count()}`);
  console.log('subs: ' + JSON.stringify(SUBS));

  if (mode === 'main') {
    await step('M-51-01: OpenAPI of the sample routes', async () => {
      const res = await fetch(`${base}/docs-json`);
      const doc = (await res.json()) as {
        paths: Record<string, { get?: Record<string, unknown> & { responses: object } }>;
      };
      for (const route of ['admin', 'operator', 'any']) {
        const op = doc.paths[`/v1/sample/${route}`]?.get;
        console.log(
          `/v1/sample/${route}: x-roles=${JSON.stringify(op?.['x-roles'])} ` +
            `403-response=${op ? '403' in op.responses : 'missing'}`,
        );
      }
    });

    await step('M-51-02: each role calls the endpoint of its own role', async () => {
      for (const role of ROLE_NAMES) {
        show(
          `${role} -> /sample/${role}`,
          await call('GET', `/v1/sample/${role}`, await token(SUBS[role], [role])),
        );
      }
      for (const role of ROLE_NAMES) {
        show(
          `${role} /whoami`,
          await call('GET', '/v1/sample/whoami', await token(SUBS[role], [role])),
        );
      }
    });

    await step(
      'M-51-03: the 12-cell denial matrix (every role calls the other three)',
      async () => {
        const before = handlersRun();
        for (const caller of ROLE_NAMES) {
          for (const target of ROLE_NAMES) {
            if (caller === target) continue;
            show(
              `${caller} -> /sample/${target}`,
              await call('GET', `/v1/sample/${target}`, await token(SUBS[caller], [caller])),
            );
          }
        }
        console.log(`handlers run during the matrix (must be 0): ${handlersRun() - before}`);
      },
    );

    await step('M-51-04: no group, several groups, an unknown group', async () => {
      show(
        'no group -> /customer',
        await call('GET', '/v1/sample/customer', await token(SUBS.noGroup)),
      );
      show(
        'no group -> /operator',
        await call('GET', '/v1/sample/operator', await token(SUBS.noGroup)),
      );
      const multi = await token(SUBS.multi, ['operator', 'auditor']);
      for (const target of ['operator', 'auditor', 'admin']) {
        show(`operator+auditor -> /${target}`, await call('GET', `/v1/sample/${target}`, multi));
      }
      show(
        'unknown group "ops" /whoami',
        await call('GET', '/v1/sample/whoami', await token(SUBS.unknownGroup, ['ops'])),
      );
    });

    await step(
      'M-51-05: a customer claims admin in a header, a cookie, the query and a body',
      async () => {
        const t = await token(SUBS.customer, ['customer']);
        show(
          'GET /admin?role=admin with X-Role and cookie',
          await call('GET', '/v1/sample/admin?role=admin', t, {
            headers: { 'X-Role': 'admin', 'X-Cognito-Groups': 'admin', Cookie: 'role=admin' },
          }),
        );
        show(
          'POST /echo-admin with a body that says admin',
          await call('POST', '/v1/sample/echo-admin?role=admin', t, {
            headers: { 'X-Role': 'admin' },
            body: { role: 'admin', roles: ['admin'], 'cognito:groups': ['admin'] },
          }),
        );
        show(
          'GET /whoami with the same claims',
          await call('GET', '/v1/sample/whoami?role=admin', t, { headers: { 'X-Role': 'admin' } }),
        );
      },
    );

    await step('M-51-06: an edited payload and a token signed by another key', async () => {
      const [header, , signature] = (await token(SUBS.forger, [])).split('.');
      const payload = Buffer.from(
        JSON.stringify({
          sub: SUBS.forger,
          iss: issuer,
          client_id: CLIENT_ID,
          token_use: 'access',
          'cognito:groups': ['admin'],
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString('base64url');
      show(
        'edited payload (admin)',
        await call('GET', '/v1/sample/admin', `${header}.${payload}.${signature}`),
      );
      const other = await generateKeyPair('RS256');
      show(
        'unknown signing key (admin)',
        await call(
          'GET',
          '/v1/sample/admin',
          await token(SUBS.forger, ['admin'], 900, other.privateKey),
        ),
      );
      console.log(`row for the forger (must be none): ${await idOf(SUBS.forger)}`);
    });

    await step('M-51-07: no token, and an expired token', async () => {
      show('no token -> /operator', await call('GET', '/v1/sample/operator'));
      show(
        'expired operator token -> /operator',
        await call('GET', '/v1/sample/operator', await token(SUBS.operator, ['operator'], -3600)),
      );
    });

    await step('M-51-08: userId equals users.id in the database', async () => {
      for (const role of ROLE_NAMES) {
        const reply = await call('GET', '/v1/sample/whoami', await token(SUBS[role], [role]));
        const dbId = await idOf(SUBS[role]);
        console.log(
          `${role}: userId=${String(reply.body.userId)} users.id=${String(dbId)} same=${reply.body.userId === dbId}`,
        );
      }
    });

    await step('M-51-11: cognito:groups of the wrong type', async () => {
      show(
        'groups = "admin" (a string) -> /admin',
        await call('GET', '/v1/sample/admin', await token(SUBS.stringGroups, 'admin')),
      );
      show(
        'groups = ["admin "] (trailing space) -> /admin',
        await call('GET', '/v1/sample/admin', await token(SUBS.spaceGroup, ['admin '])),
      );
      show(
        'groups = "admin" /whoami',
        await call('GET', '/v1/sample/whoami', await token(SUBS.stringGroups, 'admin')),
      );
      show(
        'groups = ["admin "] /whoami',
        await call('GET', '/v1/sample/whoami', await token(SUBS.spaceGroup, ['admin '])),
      );
    });

    await step(
      'M-51-12: the default for a route with no @Roles, and @Public with @Roles',
      async () => {
        for (const role of ROLE_NAMES) {
          show(
            `${role} -> /any`,
            await call('GET', '/v1/sample/any', await token(SUBS[role], [role])),
          );
        }
        show('no group -> /any', await call('GET', '/v1/sample/any', await token(SUBS.noGroup)));
        show('no token -> /any', await call('GET', '/v1/sample/any'));
        show(
          'admin token -> /public-roles',
          await call('GET', '/v1/sample/public-roles', await token(SUBS.admin, ['admin'])),
        );
      },
    );
  }

  if (mode === 'outage') {
    const outageSub = randomUUID();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const t = await token(outageSub, ['operator']);
    console.log(`\n--- M-51-09: PostgreSQL stopped (new sub ${outageSub}) ---`);
    await rl.question(
      '\nStop PostgreSQL now (docker compose stop postgres), wait 35 s, then press Enter... ',
    );
    show(
      'operator, never seen before, while PostgreSQL is down',
      await call('GET', '/v1/sample/operator', t),
    );

    console.log('\n--- PostgreSQL started again ---');
    await rl.question(
      '\nStart PostgreSQL (docker compose start postgres), wait until healthy, then press Enter... ',
    );
    rl.close();
    show('same token after recovery', await call('GET', '/v1/sample/operator', t));
    console.log(`row in DB: id=${String(await idOf(outageSub))}`);
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
