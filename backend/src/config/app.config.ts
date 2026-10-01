import { registerAs } from '@nestjs/config';
import { validateEnv } from './validation.schema';

export const appConfig = registerAs('app', () => {
  const env = validateEnv(process.env);
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    role: env.APP_ROLE,
    logLevel: env.LOG_LEVEL,
    trustProxyHops: env.TRUST_PROXY_HOPS,
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map(origin => origin.trim())
      .filter(origin => origin.length > 0),
  };
});
