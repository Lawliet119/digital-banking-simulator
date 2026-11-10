import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { RequestHandler } from 'express';
import { DataSource, type QueryRunner } from 'typeorm';
import { PinoLogger } from 'nestjs-pino';
import { appConfig } from '@config/app.config';
import { authConfig } from '@config/auth.config';
import { databaseConfig } from '@config/database.config';
import { limitsConfig } from '@config/limits.config';
import { redisConfig } from '@config/redis.config';
import { RateLimitModule, TransferRateLimitGuard } from '@common/rate-limit';
import { HealthModule } from '@modules/health';
import { LOCAL_CLIENT_ID, LOCAL_ISSUER } from '@config/auth-local';
import { TransactionService } from '@database/transaction.service';
import { assertNotMigratorUser } from '@database/database-url.guard';
import { AccountsModule } from '@modules/accounts';
import { AuditHttpModule, AuditModule } from '@modules/audit';
import { OutboxModule } from '@modules/outbox';
import { LedgerModule } from '@modules/ledger';
import { FraudHttpModule } from '@modules/risk/fraud-http.module';
import {
  IdentityModule,
  JwtAuthGuard,
  RolesGuard,
  SessionRevocationModule,
} from '@modules/identity';
import { configureHttpApp, setupSwagger } from '../../src/app.setup';
import { createHttpLogging } from '@common/logging/http-logging';
import { createDevTokenIssuer, type DevTokenIssuer } from './dev-tokens';

const settings = {
  role: 'api' as const,
  logLevel: 'fatal',
  trustProxyHops: 0,
  corsOrigins: [],
  isProduction: false,
};
/** Mutable on purpose: a test that moves more than the real limits allow raises them and restores. */
export interface FixtureLimits {
  transfer: { perTx: bigint; perDay: bigint };
  rateLimit: { transfersPerMinute: number; requestsPerIpPerMinute: number };
}

export interface DepositApp {
  app: NestExpressApplication;
  url: string;
  source: DataSource;
  issuer: DevTokenIssuer;
  limits: FixtureLimits;
  close(): Promise<void>;
}
/** DBS-89: run the app with the real rate-limit guards against a real Redis (Valkey). */
export interface RateLimitFixture {
  redisUrl: string;
  trustProxyHops?: number;
  transfersPerMinute?: number;
  requestsPerIpPerMinute?: number;
}
/** Per-transaction database waits; defaults match env/.env.example. A test shortens them to hit a timeout quickly. */
export interface DbTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}
const DEFAULT_TIMEOUTS: DbTimeouts = {
  lockTimeoutMs: 2000,
  statementTimeoutMs: 5000,
  idleInTransactionTimeoutMs: 10000,
};
@Global()
@Module({})
class DepositFixtureConfig {
  static forRoot(auth: unknown, limits: FixtureLimits, timeouts: DbTimeouts): DynamicModule {
    return {
      module: DepositFixtureConfig,
      providers: [
        { provide: authConfig.KEY, useValue: auth },
        { provide: appConfig.KEY, useValue: settings },
        {
          provide: databaseConfig.KEY,
          useValue: timeouts,
        },
        {
          provide: limitsConfig.KEY,
          useValue: limits,
        },
        TransactionService,
      ],
      exports: [
        authConfig.KEY,
        appConfig.KEY,
        databaseConfig.KEY,
        limitsConfig.KEY,
        TransactionService,
      ],
    };
  }
}

/** Actual modules, JWT/identity and Pino context. Only test configuration supplied. */
export async function startDepositApp(
  databaseUrl: string,
  options: {
    timeouts?: Partial<DbTimeouts>;
    rateLimit?: RateLimitFixture;
    poolMax?: number;
    /** DBS-144: the HTTP metrics middleware, mounted as `main.ts` mounts it. */
    metrics?: RequestHandler;
    revocation?: { redisUrl: string };
    /** Opt-in to keep unrelated HTTP fixtures independent of fraud schema. */
    fraud?: boolean;
    auditHttp?: boolean;
    withSwagger?: boolean;
  } = {},
): Promise<DepositApp> {
  const issuer = await createDevTokenIssuer(),
    tempRoot = resolve(tmpdir());
  const dir = mkdtempSync(join(tempRoot, 'dbs60-jwks-')),
    jwksPath = join(dir, 'jwks.json');
  writeFileSync(jwksPath, JSON.stringify(issuer.jwks));
  const limits: FixtureLimits = {
    transfer: { perTx: 50_000_000n, perDay: 200_000_000n },
    rateLimit: {
      transfersPerMinute: options.rateLimit?.transfersPerMinute ?? 10,
      requestsPerIpPerMinute: options.rateLimit?.requestsPerIpPerMinute ?? 100,
    },
  };
  const appSettings = { ...settings, trustProxyHops: options.rateLimit?.trustProxyHops ?? 0 };
  let app: NestExpressApplication | undefined, module: TestingModule | undefined;
  const close = async () => {
    if (dirname(resolve(dir)) !== tempRoot || !basename(dir).startsWith('dbs60-jwks-'))
      throw new Error('Unsafe temporary JWKS path');
    try {
      if (app) await app.close();
      else await module?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    assertNotMigratorUser(databaseUrl);
    const rateLimit = options.rateLimit;
    const builder = Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: databaseUrl,
          entities: [],
          synchronize: false,
          retryAttempts: 0,
          extra: { max: options.poolMax ?? 30, connectionTimeoutMillis: 1000 },
        }),
        DepositFixtureConfig.forRoot(
          {
            local: { jwksPath },
            cognito: { clientId: LOCAL_CLIENT_ID, issuer: LOCAL_ISSUER, jwksCooldownMs: 60000 },
            accessTokenTtlSeconds: 900,
          },
          limits,
          { ...DEFAULT_TIMEOUTS, ...options.timeouts },
        ),
        IdentityModule,
        ...(options.revocation ? [SessionRevocationModule] : []),
        AccountsModule,
        ...(options.auditHttp ? [AuditHttpModule] : [AuditModule]),
        OutboxModule,
        LedgerModule,
        ...(options.fraud ? [FraudHttpModule] : []),
        ...(rateLimit ? [RateLimitModule, HealthModule] : []),
      ],
      // The same order as AppModule: JWT, roles, per-customer transfer limit (the IP limit is the
      // middleware of RateLimitModule).
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        ...(rateLimit ? [{ provide: APP_GUARD, useClass: TransferRateLimitGuard }] : []),
      ],
    });
    const redisUrl = options.revocation?.redisUrl ?? rateLimit?.redisUrl;
    if (redisUrl) {
      builder.overrideProvider(redisConfig.KEY).useValue({ url: redisUrl, commandTimeoutMs: 50 });
    }
    module = await builder.compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false });
    configureHttpApp(
      app,
      appSettings,
      createHttpLogging(await app.resolve(PinoLogger), appSettings),
      options.metrics,
    );
    if (options.withSwagger) setupSwagger(app);
    await app.listen(0, '127.0.0.1');
    return { app, url: await app.getUrl(), source: app.get(DataSource), issuer, limits, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** SQL INPUT fixture: no balances or ledger rows specified; accounts start at migration default zero. */
export async function seedDepositTarget(
  runner: Pick<QueryRunner, 'query'>,
  status: 'ACTIVE' | 'LOCKED' = 'ACTIVE',
) {
  const userId = randomUUID(),
    customerId = randomUUID(),
    accountId = randomUUID(),
    sub = randomUUID();
  await runner.query('INSERT INTO users(id,cognito_sub) VALUES($1,$2)', [userId, sub]);
  await runner.query('INSERT INTO customers(id,user_id,full_name) VALUES($1,$2,$3)', [
    customerId,
    userId,
    'Nguyễn Minh Anh',
  ]);
  await runner.query(
    "INSERT INTO accounts(id,customer_id,type,status) VALUES($1,$2,'CHECKING',$3)",
    [accountId, customerId, status],
  );
  return { userId, customerId, accountId, sub };
}
