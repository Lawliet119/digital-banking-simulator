import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { appConfig } from '@config/app.config';
import { authConfig } from '@config/auth.config';
import { databaseConfig } from '@config/database.config';
import { TransactionService } from '@database/transaction.service';
import { AccountsModule } from '@modules/accounts';
import { IdentityModule, JwtAuthGuard, RolesGuard } from '@modules/identity';
import { LOCAL_CLIENT_ID, LOCAL_ISSUER } from '@config/auth-local';
import { configureHttpApp } from '../../src/app.setup';
import { createDevTokenIssuer } from './dev-tokens';

const settings = {
  role: 'api' as const,
  logLevel: 'fatal',
  trustProxyHops: 0,
  corsOrigins: [],
  isProduction: false,
};

@Global()
@Module({})
class OnboardingFixtureConfig {
  static forRoot(auth: unknown): DynamicModule {
    return {
      module: OnboardingFixtureConfig,
      providers: [
        { provide: appConfig.KEY, useValue: settings },
        { provide: authConfig.KEY, useValue: auth },
        {
          provide: databaseConfig.KEY,
          useValue: {
            lockTimeoutMs: 2000,
            statementTimeoutMs: 5000,
            idleInTransactionTimeoutMs: 10000,
          },
        },
        TransactionService,
      ],
      exports: [appConfig.KEY, authConfig.KEY, databaseConfig.KEY, TransactionService],
    };
  }
}

/** Full HTTP/auth/identity/transaction/audit pipeline; only configuration is supplied by fixture. */
export async function startOnboardingApp(databaseUrl: string) {
  const issuer = await createDevTokenIssuer();
  const tempRoot = resolve(tmpdir());
  const dir = mkdtempSync(join(tempRoot, 'dbs62-jwks-'));
  const jwksPath = join(dir, 'jwks.json');
  writeFileSync(jwksPath, JSON.stringify(issuer.jwks));
  let app: NestExpressApplication | undefined;
  let module: TestingModule | undefined;
  const close = async () => {
    if (dirname(resolve(dir)) !== tempRoot || !basename(dir).startsWith('dbs62-jwks-'))
      throw new Error('Unsafe JWKS temporary path');
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
        OnboardingFixtureConfig.forRoot({
          local: { jwksPath },
          cognito: { clientId: LOCAL_CLIENT_ID, issuer: LOCAL_ISSUER, jwksCooldownMs: 60000 },
          accessTokenTtlSeconds: 900,
        }),
        IdentityModule,
        AccountsModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false });
    configureHttpApp(app, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
    await app.listen(0, '127.0.0.1');
    return { app, url: await app.getUrl(), source: app.get(DataSource), issuer, close };
  } catch (error) {
    await close();
    throw error;
  }
}
