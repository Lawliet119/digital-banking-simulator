// Must stay the first import: it fills process.env from env/.env.<NODE_ENV> for the TypeORM CLI.
import '../config/env.bootstrap';
import { DataSource } from 'typeorm';
import { buildSslOptions } from './pg-ssl';
import { SnakeNamingStrategy } from './snake-naming.strategy';

/**
 * DataSource used ONLY by the TypeORM CLI (migrations). The running app builds its own connection
 * in DatabaseModule. Paths are relative on purpose: this file runs under ts-node during
 * development and as compiled JS (`dist/database/data-source.js`) in the deployment pipeline.
 *
 * Exported as a factory too so the database tests migrate a throwaway database with exactly the
 * configuration the CLI uses.
 */
export function createMigrationDataSource(url: string | undefined): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    ssl: buildSslOptions({
      enabled: process.env.DATABASE_SSL === 'true',
      caPath: process.env.DATABASE_SSL_CA_PATH,
    }),
    namingStrategy: new SnakeNamingStrategy(),
    entities: [`${__dirname}/../**/*.entity.{ts,js}`],
    migrations: [`${__dirname}/migrations/*.{ts,js}`],
  });
}

export default createMigrationDataSource(process.env.DATABASE_URL);
