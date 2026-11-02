import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';
import { signDevToken } from '../../src/scripts/dev-auth';
import type { Role } from '../../src/modules/identity';

export interface DevTokenOptions {
  /** Defaults to `dev-<role>`, the same default as `npm run auth:dev-token`. */
  sub?: string;
  /** Seconds since the epoch. Defaults to now. */
  iat?: number;
  /** Seconds since the epoch. Defaults to `iat + 900`. */
  exp?: number;
}

export interface DevTokenIssuer {
  /** The `kid` of the key in `jwks`. */
  kid: string;
  /** The public half, in the shape `AUTH_LOCAL_JWKS_PATH` points at. */
  jwks: { keys: JWK[] };
  /** A signed access token for exactly one of the four roles. Same rules as the CLI. */
  token(role: Role, options?: DevTokenOptions): Promise<string>;
}

/**
 * Token helper for e2e tests (DBS-53, ADR-06): a key pair made in memory, never written to disk,
 * and tokens signed by the same function `npm run auth:dev-token` uses, so a test token and a
 * hand-made one cannot drift apart. Only the four roles can be issued; a test that needs an odd
 * claim signs its own token, as test/support/roles-app.ts does.
 *
 * `kid` is only for the test that needs two issuers sharing one: a key id never proves identity,
 * the signature does.
 */
export async function createDevTokenIssuer(
  options: { kid?: string } = {},
): Promise<DevTokenIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const kid = options.kid ?? (await calculateJwkThumbprint(jwk));
  return {
    kid,
    jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] },
    token: (role, tokenOptions = {}) => signDevToken(privateKey, kid, { role, ...tokenOptions }),
  };
}
