import { registerAs } from '@nestjs/config';
import { validateEnv } from './validation.schema';

export const redisConfig = registerAs('redis', () => {
  const env = validateEnv(process.env);
  return {
    url: env.REDIS_URL,
    commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
  };
});
