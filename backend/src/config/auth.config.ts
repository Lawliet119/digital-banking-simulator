import { registerAs } from '@nestjs/config';
import { LOCAL_CLIENT_ID, LOCAL_ISSUER } from './auth-local';
import { validateEnv } from './validation.schema';

export const authConfig = registerAs('auth', () => {
  const env = validateEnv(process.env);
  // AUTH_MODE=local (DBS-53, development and test only; the schema refuses it elsewhere). The
  // token is still checked for issuer and client id, against fixed values, and the keys come from
  // a file instead of Cognito's JWKS URL.
  const local =
    env.AUTH_MODE === 'local' && env.AUTH_LOCAL_JWKS_PATH
      ? { jwksPath: env.AUTH_LOCAL_JWKS_PATH }
      : undefined;
  return {
    /**
     * Present exactly when AUTH_MODE=local. The key is absent otherwise (not `undefined`), which
     * makes the inferred type optional, so a hand-written test config without it still compiles.
     */
    ...(local ? { local } : {}),
    cognito: {
      userPoolId: env.COGNITO_USER_POOL_ID,
      clientId: local ? LOCAL_CLIENT_ID : env.COGNITO_CLIENT_ID,
      issuer: local ? LOCAL_ISSUER : env.COGNITO_ISSUER,
      /** Cognito's fixed convention; derived, never a separate env var. Strips a trailing slash
       * so a copy-pasted issuer URL with one doesn't produce a double slash before the path.
       * Never set in local mode: no request leaves the machine to verify a local token. */
      jwksUri:
        !local && env.COGNITO_ISSUER
          ? `${env.COGNITO_ISSUER.replace(/\/+$/, '')}/.well-known/jwks.json`
          : undefined,
      /** >= 1 min in a deployed env by Joi default; tests override this to go fast. */
      jwksCooldownMs: env.JWKS_REFETCH_COOLDOWN_MS,
    },
    /** Lifetime of an access token; also the TTL of the "sessions revoked" marker in Redis. */
    accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  };
});
