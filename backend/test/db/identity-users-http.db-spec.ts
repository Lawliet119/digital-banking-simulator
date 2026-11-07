import { Global, Module, type DynamicModule, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { KeyLike } from 'jose';
import { configureHttpApp } from '../../src/app.setup';
import { ErrorCode } from '../../src/common/errors/error-code.enum';
import { appConfig, databaseConfig } from '../../src/config';
import { authConfig } from '../../src/config/auth.config';
import { DatabaseModule } from '../../src/database/database.module';
import { TransactionService } from '../../src/database/transaction.service';
import { IdentityModule } from '../../src/modules/identity';
import { startJwksFixture, type JwksFixture } from '../support/jwks-fixture';
import {
  createIdentityUsersFixture,
  type IdentityUsersFixture,
} from '../support/identity-users-probe';

const ISSUER = 'https://issuer.test';
const CLIENT_ID = 'test-client';
const POOL_MAX = 10;
const LOCK_TIMEOUT_MS = 300;
const sub = (n: number): string => `7c2e9a41-6b5d-4f08-a3c1-${String(n).padStart(12, '0')}`;

interface MeBody {
  userId?: string;
  groups?: string[];
  errorCode?: string;
  correlationId?: string;
}

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
        poolMax: POOL_MAX,
        ssl: false,
        sslCaPath: undefined,
        lockTimeoutMs: LOCK_TIMEOUT_MS,
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
    return {
      module: FakeConfigModule,
      providers,
      exports: providers.map(p => p.provide),
    };
  }
}

describe('DBS-52 users provisioning over HTTP (real AppModule pieces, PostgreSQL)', () => {
  let db: IdentityUsersFixture;
  let jwks: JwksFixture;
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let privateKey: KeyLike;

  beforeAll(async () => {
    db = await createIdentityUsersFixture();
    jwks = await startJwksFixture();
    const key = await jwks.generateKey('kid-http-1');
    privateKey = key.privateKey;
    jwks.rotate('kid-http-1', key.publicJwk);

    const moduleRef = await Test.createTestingModule({
      imports: [FakeConfigModule.forRoot(db.url, jwks.url), DatabaseModule, IdentityModule],
    }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(nest, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
    await nest.init();
    app = nest;
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });
  afterAll(async () => {
    await app?.close();
    await jwks?.close();
    await db?.close();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const token = (subject: string, overrides: Record<string, unknown> = {}, exp = 900) =>
    jwks.signWith(
      'kid-http-1',
      privateKey,
      {
        sub: subject,
        iss: ISSUER,
        client_id: CLIENT_ID,
        token_use: 'access',
        ...overrides,
      },
      exp,
    );
  interface MeResponse {
    status: number;
    headers: Record<string, string>;
    body: MeBody;
  }
  const call = async (bearer: string): Promise<MeResponse> => {
    const res = await request(server).get('/v1/identity/me').set('Authorization', bearer);
    return {
      status: res.status,
      headers: res.headers,
      body: res.body as MeBody,
    };
  };
  /** GET /v1/identity/me with a freshly signed token. Asserts go through `statusOf` below. */
  const me = async (subject: string, overrides: Record<string, unknown> = {}, exp = 900) =>
    call(`Bearer ${await token(subject, overrides, exp)}`);
  const rows = (subjects: string[]) => db.countUsers(subjects);
  const statusOf = <T extends { status: number }>(res: T, expected: number): T => {
    expect(res.status).toBe(expected);
    return res;
  };

  it('TC-52-18 creates the row on the first valid token (no group = customer) and reuses it', async () => {
    const subject = sub(18);

    const first = statusOf(await me(subject), 200);
    const second = statusOf(await me(subject), 200);

    expect(first.body.groups).toEqual([]);
    expect(second.body.userId).toBe(first.body.userId);
    const stored = await db.admin.query<{ id: string }[]>(
      'SELECT id FROM users WHERE cognito_sub = $1',
      [subject],
    );
    expect(stored).toEqual([{ id: first.body.userId }]);
    expect(await rows([subject])).toBe(1);
  });

  it.each(['customer', 'operator', 'auditor', 'admin'])(
    'TC-52-18 provisions a %s the same way',
    async group => {
      const subject = sub(180 + ['customer', 'operator', 'auditor', 'admin'].indexOf(group));

      const res = statusOf(await me(subject, { 'cognito:groups': [group] }), 200);

      expect(res.body.groups).toEqual([group]);
      expect(await rows([subject])).toBe(1);
    },
  );

  it('TC-52-19 never creates a row for a token that fails verification', async () => {
    const bad = sub(19);
    const before = await db.admin.query<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM users',
    );
    const other = await jwks.generateKey('kid-unknown');
    const foreign = await jwks.signWith('kid-unknown', other.privateKey, {
      sub: bad,
      iss: ISSUER,
      client_id: CLIENT_ID,
      token_use: 'access',
    });

    const noSubjectToken = await jwks.signWith('kid-http-1', privateKey, {
      iss: ISSUER,
      client_id: CLIENT_ID,
      token_use: 'access',
    });
    const badSignature = statusOf(await call(`Bearer ${foreign}`), 401);
    const expired = statusOf(await me(bad, {}, -60), 401);
    const idToken = statusOf(await me(bad, { token_use: 'id' }), 401);
    const noSubject = statusOf(await call(`Bearer ${noSubjectToken}`), 401);

    expect(badSignature.body.errorCode).toBe(ErrorCode.UNAUTHENTICATED);
    expect(expired.body.errorCode).toBe(ErrorCode.TOKEN_EXPIRED);
    expect(idToken.body.errorCode).toBe(ErrorCode.UNAUTHENTICATED);
    expect(noSubject.body.errorCode).toBe(ErrorCode.UNAUTHENTICATED);
    const after = await db.admin.query<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM users',
    );
    expect(after).toEqual(before);
  });

  it('TC-52-20 20 parallel HTTP requests for a new sub all succeed with one userId and one row', async () => {
    const subject = sub(20);
    const bearer = `Bearer ${await token(subject)}`;

    const responses = await Promise.all(Array.from({ length: 20 }, () => call(bearer)));

    expect(responses.map(r => r.status)).toEqual(Array(20).fill(200));
    expect(new Set(responses.map(r => r.body.userId)).size).toBe(1);
    expect(await rows([subject])).toBe(1);
  });

  it('TC-52-21 a transient database error is a 503 that is not cached: the next request succeeds', async () => {
    const subject = sub(21);
    const transient = Object.assign(
      new Error('terminating connection due to administrator command'),
      {
        code: '57P01',
      },
    );
    jest.spyOn(TransactionService.prototype, 'run').mockRejectedValueOnce(transient);

    const failed = statusOf(await me(subject), 503);
    const retried = statusOf(await me(subject), 200);

    expect(failed.body.errorCode).toBe(ErrorCode.SERVICE_TEMPORARILY_UNAVAILABLE);
    expect(failed.headers['retry-after']).toBe('5');
    expect(failed.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(failed.body.correlationId).toEqual(expect.any(String));
    expect(retried.body.userId).toEqual(expect.any(String));
    expect(await rows([subject])).toBe(1);
  });

  it('TC-52-25 (a,b) a real lock wait past lock_timeout answers 503 quickly, then recovers', async () => {
    const subject = sub(25);
    const holder = await db.openHolder(subject); // uncommitted INSERT of the same sub

    const started = Date.now();
    const blocked = statusOf(await me(subject), 503);
    const elapsed = Date.now() - started;
    await holder.rollback();
    const recovered = statusOf(await me(subject), 200);

    expect(blocked.body.errorCode).toBe(ErrorCode.SERVICE_TEMPORARILY_UNAVAILABLE);
    expect(blocked.headers['retry-after']).toBe('5');
    expect(elapsed).toBeLessThan(2500); // 300 ms lock_timeout, not an indefinite wait
    expect(recovered.status).toBe(200);
    expect(await rows([subject])).toBe(1);
  });

  it('TC-52-25 (c) 25 distinct subs behind a table lock all fail fast, and the pool is still usable', async () => {
    const subjects = Array.from({ length: 25 }, (_, i) => sub(250 + i)); // more than POOL_MAX
    const lock = await db.openTableLock();

    const responses = await Promise.all(subjects.map(s => me(s)));
    await lock.rollback();
    const after = await me(sub(299));

    expect(responses.map(r => r.status)).toEqual(Array(25).fill(503));
    expect(new Set(responses.map(r => r.body.errorCode))).toEqual(
      new Set([ErrorCode.SERVICE_TEMPORARILY_UNAVAILABLE]),
    );
    expect(await rows(subjects)).toBe(0);
    expect(after.status).toBe(200);
  });
});
