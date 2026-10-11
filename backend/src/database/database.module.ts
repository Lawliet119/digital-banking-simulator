import { Global, Module } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { TypeOrmModule, type TypeOrmModuleOptions } from '@nestjs/typeorm';
import { appConfig, databaseConfig } from '../config';
import { buildSslOptions } from './pg-ssl';
import { SnakeNamingStrategy } from './snake-naming.strategy';
import { TransactionService } from './transaction.service';

export function buildTypeOrmOptions(
  db: ConfigType<typeof databaseConfig>,
  app: ConfigType<typeof appConfig>,
): TypeOrmModuleOptions {
  return {
    type: 'postgres' as const,
    url: db.url,
    ssl: buildSslOptions({ enabled: db.ssl, caPath: db.sslCaPath }),
    applicationName: `dbs-${app.role}`,
    autoLoadEntities: true,
    // Same naming as the migration CLI (data-source.ts), so entities and hand-written SQL agree.
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    migrationsRun: false,
    // Fail fast and let the orchestrator restart the task rather than retrying for minutes.
    retryAttempts: 5,
    retryDelay: 2000,
    // Per-instance pool. Keep (number of tasks × poolMax) below RDS max_connections.
    extra: {
      max: db.poolMax,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
    },
  };
}

/**
 * PostgreSQL connection (TypeORM) and the transaction helper.
 *
 * `synchronize` is OFF and migrations never run at startup: with several tasks starting at once,
 * schema changes are a separate pipeline step (`npm run migration:run:prod`), written in the
 * expand → migrate → contract style so the previous release keeps working during a deploy.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [databaseConfig.KEY, appConfig.KEY],
      useFactory: buildTypeOrmOptions,
    }),
  ],
  providers: [TransactionService],
  exports: [TransactionService],
})
export class DatabaseModule {}
