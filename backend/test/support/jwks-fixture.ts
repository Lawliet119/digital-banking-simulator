import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload, type KeyLike } from 'jose';

/**
 * A disposable, in-memory JWKS HTTP server for tests. Lets a spec sign tokens with a real
 * keypair and exercise JwksVerifierService's caching/refetch/rotation behaviour against a real
 * HTTP round-trip, without depending on DBS-53's file-based local JWKS path.
 */
export interface JwksFixture {
  url: string;
  /** Number of GET requests the fixture's JWKS endpoint has served so far. */
  readonly fetchCount: number;
  generateKey(kid: string): Promise<{ privateKey: KeyLike; publicJwk: JWK }>;
  /** Replaces the served key set with exactly this one key (simulates Cognito key rotation). */
  rotate(kid: string, publicJwk: JWK): void;
  signWith(
    kid: string,
    privateKey: KeyLike,
    claims: JWTPayload,
    expSeconds?: number,
  ): Promise<string>;
  close(): Promise<void>;
}

export async function startJwksFixture(): Promise<JwksFixture> {
  let keys: JWK[] = [];
  let fetchCount = 0;

  const server: Server = createServer((_req, res) => {
    fetchCount++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/.well-known/jwks.json`;

  return {
    url,
    get fetchCount() {
      return fetchCount;
    },
    async generateKey(kid: string) {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
      return { privateKey, publicJwk };
    },
    rotate(kid: string, publicJwk: JWK) {
      keys = [{ ...publicJwk, kid }];
    },
    async signWith(kid: string, privateKey: KeyLike, claims: JWTPayload, expSeconds = 900) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
        .sign(privateKey);
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve())),
      );
    },
  };
}
