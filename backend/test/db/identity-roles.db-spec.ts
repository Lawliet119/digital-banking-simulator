import { Global, Module, type DynamicModule, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { KeyLike } from 'jose';
import { configureHttpApp } from '../../src/app.setup';
import { Public } from '../../src/common/auth/public.decorator';
import { appConfig, databaseConfig } from '../../src/config';
import { authConfig } from '../../src/config/auth.config';
import { DatabaseModule } from '../../src/database/database.module';
import {
  CurrentUser,
  IdentityModule,
  JwtAuthGuard,
  Roles,
  RolesGuard,
  ROLES,
  type CurrentUserInfo,
} from '../../src/modules/identity';
import { Controller, Get } from '@nestjs/common';
import { startJwksFixture, type JwksFixture } from '../support/jwks-fixture';
import {
  createIdentityUsersFixture,
  type IdentityUsersFixture,
} from '../support/identity-users-probe';

const ISSUER = 'https://issuer.test';
const CLIENT_ID = 'test-client';
const KID = 'kid-roles-db';
const sub = (n: number): string => `3a9d5e72-4c1b-4f86-b0d3-${String(n).padStart(12, '0')}`;

@Controller('whoami')
class WhoAmIController {
  @Get()
  @Roles(...ROLES)
  who(@CurrentUser() who: CurrentUserInfo): CurrentUserInfo {
    return who;
  }

  @Get('open')
  @Public()
  open(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [WhoAmIController] })
class WhoAmIModule {}

/** Config the real ConfigModule would build from env, here pointed at the throwaway database. */
@Global()
@Module({})
class FakeConfigModule {
  static forRoot(url: string, jwksUri: string): DynamicModule {
    const value = (key: string | symbol, useValue: unknown) => ({ provide: key, useValue });
    const providers = [
      value(authConfig.KEY, {
        cognito: {
          userPoolId: 'pool-test',
          clientId: CLIENT_ID,
          issuer: ISSUER,
          jwksUri,
          jwksCooldownMs: 200,
        },
        accessTokenTtlSeconds: 900,
      }),
      value(databaseConfig.KEY, {
        url,
        poolMax: 10,
        ssl: false,
        sslCaPath: undefined,
        lockTimeoutMs: 2000,
        statementTimeoutMs: 5000,
        idleInTransactionTimeoutMs: 10_000,
      }),
      value(appConfig.KEY, {
        env: 'test',
        isProduction: false,
        port: 0,
        role: 'api',
        logLevel: 'error',
        trustProxyHops: 0,
        corsOrigins: [],
      }),
    ];
    return { module: FakeConfigModule, providers, exports: providers.map(p => p.provide) };
  }
}

// Here nothing is replaced: the real IdentityService writes the real `users` row in a migrated
// PostgreSQL, so `userId` in @CurrentUser is proved to be users.id and not a value the test made up.
describe('DBS-51 @CurrentUser userId against PostgreSQL', () => {
  let db: IdentityUsersFixture;
  let jwks: JwksFixture;
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let privateKey: KeyLike;

  beforeAll(async () => {
    db = await createIdentityUsersFixture();
    jwks = await startJwksFixture();
    const key = await jwks.generateKey(KID);
    privateKey = key.privateKey;
    jwks.rotate(KID, key.publicJwk);

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeConfigModule.forRoot(db.url, jwks.url),
        DatabaseModule,
        IdentityModule,
        WhoAmIModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(nest, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
    await nest.listen(0, '127.0.0.1');
    app = nest;
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app?.close();
    await jwks?.close();
    await db?.close();
  });

  const token = (subject: string, groups?: string[]) =>
    jwks.signWith(KID, privateKey, {
      sub: subject,
      iss: ISSUER,
      client_id: CLIENT_ID,
      token_use: 'access',
      ...(groups ? { 'cognito:groups': groups } : {}),
    });

  /** The signed GET /v1/whoami, awaited to the response; callers assert the status themselves. */
  const whoAmI = async (subject: string, groups?: string[]): Promise<request.Response> => {
    const signed = await token(subject, groups);
    return request(server).get('/v1/whoami').set('Authorization', `Bearer ${signed}`);
  };
  const okBody = async (subject: string, groups?: string[]): Promise<CurrentUserInfo> => {
    const res = await whoAmI(subject, groups);
    expect(res.status).toBe(200);
    return res.body as CurrentUserInfo;
  };

  const storedId = async (subject: string): Promise<string | undefined> => {
    const rows = await db.admin.query<{ id: string }[]>(
      'SELECT id FROM users WHERE cognito_sub = $1',
      [subject],
    );
    return rows[0]?.id;
  };

  it.each([
    [1, 'customer', ['customer']],
    [2, 'operator', ['operator']],
    [3, 'auditor', ['auditor']],
    [4, 'admin', ['admin']],
    [5, 'no group', undefined],
  ])(
    'TC-51-28 a %s token gets userId equal to users.id of its cognito_sub',
    async (n, _label, groups) => {
      const subject = sub(n);

      const body = await okBody(subject, groups);

      expect(body.sub).toBe(subject);
      expect(body.roles).toEqual(groups ?? ['customer']);
      expect(body.userId).toBe(await storedId(subject));
      expect(body.userId).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('TC-51-28 calling again keeps the same userId and adds no row', async () => {
    const subject = sub(10);

    const first = await okBody(subject, ['operator']);
    const second = await okBody(subject, ['operator']);

    expect(second.userId).toBe(first.userId);
    expect(await db.countUsers([subject])).toBe(1);
  });

  it('TC-51-28 two different subs get two different userIds', async () => {
    const a = await okBody(sub(20));
    const b = await okBody(sub(21));

    expect(a.userId).not.toBe(b.userId);
  });

  it('TC-51-28 a @Public route creates no row and needs no token', async () => {
    const before = await db.admin.query<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM users',
    );

    await request(server).get('/v1/whoami/open').expect(200);

    const after = await db.admin.query<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM users',
    );
    expect(after[0].count).toBe(before[0].count);
  });
});
