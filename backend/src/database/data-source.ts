// Must stay the first import: it fills process.env from env/.env.<NODE_ENV> for the TypeORM CLI.
import '../config/env.bootstrap';
import { DataSource } from 'typeorm';
import { buildSslOptions } from './pg-ssl';

/**
 * DataSource used ONLY by the TypeORM CLI (migrations). The running app builds its own connection
 * in DatabaseModule. Paths are relative on purpose: this file runs under ts-node during
 * development and as compiled JS (`dist/database/data-source.js`) in the deployment pipeline.
 */
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: buildSslOptions({
    enabled: process.env.DATABASE_SSL === 'true',
    caPath: process.env.DATABASE_SSL_CA_PATH,
  }),
  entities: [`${__dirname}/../**/*.entity.{ts,js}`],
  migrations: [`${__dirname}/migrations/*.{ts,js}`],
});
