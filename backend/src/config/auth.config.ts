import { registerAs } from '@nestjs/config';
import { validateEnv } from './validation.schema';

export const authConfig = registerAs('auth', () => {
  const env = validateEnv(process.env);
  return {
    cognito: {
      userPoolId: env.COGNITO_USER_POOL_ID,
      clientId: env.COGNITO_CLIENT_ID,
      issuer: env.COGNITO_ISSUER,
    },
    /** Lifetime of an access token; also the TTL of the "sessions revoked" marker in Redis. */
    accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  };
});
