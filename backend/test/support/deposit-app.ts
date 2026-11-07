import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource, type QueryRunner } from 'typeorm';
import { PinoLogger } from 'nestjs-pino';
import { appConfig } from '@config/app.config';
import { authConfig } from '@config/auth.config';
import { databaseConfig } from '@config/database.config';
import { limitsConfig } from '@config/limits.config';
import { LOCAL_CLIENT_ID, LOCAL_ISSUER } from '@config/auth-local';
import { TransactionService } from '@database/transaction.service';
import { AccountsModule } from '@modules/accounts';
import { AuditModule } from '@modules/audit';
import { OutboxModule } from '@modules/outbox';
import { LedgerModule } from '@modules/ledger';
import { IdentityModule, JwtAuthGuard, RolesGuard } from '@modules/identity';
import { configureHttpApp } from '../../src/app.setup';
import { createHttpLogging } from '@common/logging/http-logging';
import { createDevTokenIssuer } from './dev-tokens';

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
}
@Global()
@Module({})
class DepositFixtureConfig {
  static forRoot(auth: unknown, limits: FixtureLimits): DynamicModule {
    return {
      module: DepositFixtureConfig,
      providers: [
        { provide: authConfig.KEY, useValue: auth },
        { provide: appConfig.KEY, useValue: settings },
        {
          provide: databaseConfig.KEY,
          useValue: {
            lockTimeoutMs: 2000,
            statementTimeoutMs: 5000,
            idleInTransactionTimeoutMs: 10000,
          },
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
export async function startDepositApp(databaseUrl: string) {
  const issuer = await createDevTokenIssuer(),
    tempRoot = resolve(tmpdir());
  const dir = mkdtempSync(join(tempRoot, 'dbs60-jwks-')),
    jwksPath = join(dir, 'jwks.json');
  writeFileSync(jwksPath, JSON.stringify(issuer.jwks));
  const limits: FixtureLimits = { transfer: { perTx: 50_000_000n, perDay: 200_000_000n } };
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
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: databaseUrl,
          entities: [],
          synchronize: false,
          retryAttempts: 0,
          extra: { max: 30, connectionTimeoutMillis: 1000 },
        }),
        DepositFixtureConfig.forRoot(
          {
            local: { jwksPath },
            cognito: { clientId: LOCAL_CLIENT_ID, issuer: LOCAL_ISSUER, jwksCooldownMs: 60000 },
            accessTokenTtlSeconds: 900,
          },
          limits,
        ),
        IdentityModule,
        AccountsModule,
        AuditModule,
        OutboxModule,
        LedgerModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false });
    configureHttpApp(app, settings, createHttpLogging(await app.resolve(PinoLogger), settings));
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
