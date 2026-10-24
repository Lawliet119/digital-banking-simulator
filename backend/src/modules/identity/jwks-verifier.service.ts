import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { authConfig } from '@config/auth.config';
import { TokenExpiredError, TokenVerificationError } from './identity.errors';
import { CognitoAccessTokenClaims } from './jwt-claims';

@Injectable()
export class JwksVerifierService {
  private readonly logger = new Logger(JwksVerifierService.name);
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(@Inject(authConfig.KEY) private readonly cfg: ConfigType<typeof authConfig>) {
    // COGNITO_ISSUER is optional outside staging/production (env/.env.example), so a local boot
    // with no Cognito configured must not crash the whole app — only a request that actually
    // reaches this guard should fail, in verifyAccessToken below.
    if (cfg.cognito.jwksUri) {
      this.jwks = createRemoteJWKSet(new URL(cfg.cognito.jwksUri), {
        cooldownDuration: cfg.cognito.jwksCooldownMs,
        timeoutDuration: 5000,
      });
    } else {
      this.logger.warn(
        'auth.cognito.jwksUri is not configured (COGNITO_ISSUER missing) — every call to verifyAccessToken will fail',
      );
    }
  }

  /**
   * Verifies signature, `iss`, `exp` (via jose) then `client_id` / `token_use` (manually —
   * Cognito ACCESS tokens carry no `aud`, only ID tokens do). No claim here is trusted before
   * `jwtVerify` has returned successfully.
   */
  async verifyAccessToken(token: string): Promise<CognitoAccessTokenClaims> {
    if (!this.jwks) {
      throw new TokenVerificationError('Cognito is not configured (COGNITO_ISSUER missing)');
    }

    let payload: CognitoAccessTokenClaims;
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.cfg.cognito.issuer,
        algorithms: ['RS256'],
        clockTolerance: 5,
      });
      payload = result.payload as unknown as CognitoAccessTokenClaims;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        this.logger.warn('access token expired');
        throw new TokenExpiredError('access token expired');
      }
      // Bad signature, unknown kid (even after the rate-limited refetch), wrong iss, malformed
      // JWT, etc. Log only the error KIND — never the token.
      this.logger.warn(`access token failed verification: ${(err as Error).name}`);
      throw new TokenVerificationError('access token failed verification', err);
    }

    if (!this.cfg.cognito.clientId || payload.client_id !== this.cfg.cognito.clientId) {
      throw new TokenVerificationError('access token has the wrong client_id');
    }
    if (payload.token_use !== 'access') {
      throw new TokenVerificationError('token_use is not "access"');
    }
    return payload;
  }
}
