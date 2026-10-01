import { registerAs } from '@nestjs/config';
import { validateEnv } from './validation.schema';

export const databaseConfig = registerAs('database', () => {
  const env = validateEnv(process.env);
  return {
    url: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
    ssl: env.DATABASE_SSL,
  };
});
