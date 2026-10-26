import { registerAs } from '@nestjs/config';
import { validateEnv } from './validation.schema';

export const authConfig = registerAs('auth', () => {
  const env = validateEnv(process.env);
  return {
    cognito: {
      userPoolId: env.COGNITO_USER_POOL_ID,
      clientId: env.COGNITO_CLIENT_ID,
      issuer: env.COGNITO_ISSUER,
      /** Cognito's fixed convention; derived, never a separate env var. Strips a trailing slash
       * so a copy-pasted issuer URL with one doesn't produce a double slash before the path. */
      jwksUri: env.COGNITO_ISSUER
        ? `${env.COGNITO_ISSUER.replace(/\/+$/, '')}/.well-known/jwks.json`
        : undefined,
      /** >= 1 min in a deployed env by Joi default; tests override this to go fast. */
      jwksCooldownMs: env.JWKS_REFETCH_COOLDOWN_MS,
    },
    /** Lifetime of an access token; also the TTL of the "sessions revoked" marker in Redis. */
    accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  };
});
