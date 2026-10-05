import { registerAs } from '@nestjs/config';
import { validateEnv } from './validation.schema';

export const databaseConfig = registerAs('database', () => {
  const env = validateEnv(process.env);
  return {
    url: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
    ssl: env.DATABASE_SSL,
    sslCaPath: env.DATABASE_SSL_CA_PATH,
    lockTimeoutMs: env.DATABASE_LOCK_TIMEOUT_MS,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    idleInTransactionTimeoutMs: env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  };
});
