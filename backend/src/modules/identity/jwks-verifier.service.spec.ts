import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload, type KeyLike } from 'jose';
import { authConfig } from '@config/auth.config';
import { TokenExpiredError, TokenVerificationError } from './identity.errors';
import { JwksVerifierService } from './jwks-verifier.service';

const ISSUER = 'https://issuer.test';
const CLIENT_ID = 'test-client';
const COOLDOWN_MS = 200;

/**
 * A disposable, in-memory JWKS HTTP server, local to this spec: lets a test sign tokens with a
 * real keypair and exercise the caching/refetch/rotation behaviour over a real HTTP round-trip,
 * without depending on DBS-53's file-based local JWKS path. Not shared via import across module
 * boundaries (lint: a module's internals never reach into `test/`) — kept here, test-only.
 */
interface JwksFixture {
  url: string;
  readonly fetchCount: number;
  generateKey(kid: string): Promise<{ privateKey: KeyLike; publicJwk: JWK }>;
  rotate(kid: string, publicJwk: JWK): void;
  signWith(
    kid: string,
    privateKey: KeyLike,
    claims: JWTPayload,
    expSeconds?: number,
  ): Promise<string>;
  close(): Promise<void>;
}

async function startJwksFixture(): Promise<JwksFixture> {
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

function configFor(fixture: JwksFixture): ConfigType<typeof authConfig> {
  return {
    cognito: {
      userPoolId: 'pool-test',
      clientId: CLIENT_ID,
      issuer: ISSUER,
      jwksUri: fixture.url,
      jwksCooldownMs: COOLDOWN_MS,
    },
    accessTokenTtlSeconds: 900,
  };
}

function baseClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'user-123',
    iss: ISSUER,
    client_id: CLIENT_ID,
    token_use: 'access',
    'cognito:groups': ['operator'],
    ...overrides,
  };
}

describe('JwksVerifierService', () => {
  let fixture: JwksFixture;
  let kid1: string;
  let key1: { privateKey: KeyLike; publicJwk: JWK };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fixture = await startJwksFixture();
    kid1 = 'kid-1';
    key1 = await fixture.generateKey(kid1);
    fixture.rotate(kid1, key1.publicJwk);
  });

  afterEach(async () => {
    // One test (below) closes the fixture itself, mid-test, to simulate the JWKS endpoint being
    // unreachable; closing an already-closed server throws, which this would otherwise surface
    // as a spurious failure on an unrelated, already-passing test.
    await fixture.close().catch(() => undefined);
    jest.restoreAllMocks();
  });

  it('accepts a validly signed token and returns its claims', async () => {
    const verifier = new JwksVerifierService(configFor(fixture));
    const token = await fixture.signWith(kid1, key1.privateKey, baseClaims());

    const claims = await verifier.verifyAccessToken(token);

    expect(claims.sub).toBe('user-123');
    expect(claims['cognito:groups']).toEqual(['operator']);
  });

  it('does not throw at construction when COGNITO_ISSUER is unset (optional in local dev)', () => {
    expect(
      () =>
        new JwksVerifierService({
          cognito: {
            userPoolId: undefined,
            clientId: undefined,
            issuer: undefined,
            jwksUri: undefined,
            jwksCooldownMs: COOLDOWN_MS,
          },
          accessTokenTtlSeconds: 900,
        }),
    ).not.toThrow();
  });

  it('fails closed (never crashes) when verifyAccessToken is called without Cognito configured', async () => {
    const verifier = new JwksVerifierService({
      cognito: {
        userPoolId: undefined,
        clientId: undefined,
        issuer: undefined,
        jwksUri: undefined,
        jwksCooldownMs: COOLDOWN_MS,
      },
      accessTokenTtlSeconds: 900,
    });

    await expect(verifier.verifyAccessToken('whatever')).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });

  it('rejects a token whose client_id claim is undefined when COGNITO_CLIENT_ID is unset', async () => {
    const verifier = new JwksVerifierService({
      cognito: {
        userPoolId: 'pool-test',
        clientId: undefined,
        issuer: ISSUER,
        jwksUri: fixture.url,
        jwksCooldownMs: COOLDOWN_MS,
      },
      accessTokenTtlSeconds: 900,
    });
    const token = await fixture.signWith(
      kid1,
      key1.privateKey,
      baseClaims({ client_id: undefined }),
    );

    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects a token with the wrong issuer', async () => {
    const verifier = new JwksVerifierService(configFor(fixture));
    const token = await fixture.signWith(
      kid1,
      key1.privateKey,
      baseClaims({ iss: 'https://evil.test' }),
    );

    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects an expired token as TokenExpiredError', async () => {
    const verifier = new JwksVerifierService(configFor(fixture));
    const token = await fixture.signWith(kid1, key1.privateKey, baseClaims(), -10);

    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('rejects a token with the wrong client_id', async () => {
    const verifier = new JwksVerifierService(configFor(fixture));
    const token = await fixture.signWith(
      kid1,
      key1.privateKey,
      baseClaims({ client_id: 'someone-else' }),
    );

    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects a token whose token_use is not "access"', async () => {
    const verifier = new JwksVerifierService(configFor(fixture));
    const token = await fixture.signWith(kid1, key1.privateKey, baseClaims({ token_use: 'id' }));

    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects a token signed by an unpublished key, triggering exactly one refetch', async () => {
    const verifier = new JwksVerifierService(configFor(fixture));
    const foreign = await fixture.generateKey('foreign-kid');
    const token = await fixture.signWith('foreign-kid', foreign.privateKey, baseClaims());
    const fetchesBefore = fixture.fetchCount;

    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(TokenVerificationError);

    expect(fixture.fetchCount).toBe(fetchesBefore + 1);
  });

  // jose's cooldown only gates a REFETCH (an unknown kid against an already-fresh cache); the
  // very first call always fetches unconditionally. So each step below that needs a refetch to
  // actually happen must wait out the cooldown since the last fetch; each step meant to prove
  // the cooldown is honoured must run immediately after the previous fetch, with no wait.
  it('refetches on key rotation once the cooldown has elapsed, but not before', async () => {
    const verifier = new JwksVerifierService(configFor(fixture));

    // Initial call: unconditional fetch (no cache yet) regardless of cooldown.
    await verifier.verifyAccessToken(await fixture.signWith(kid1, key1.privateKey, baseClaims()));
    expect(fixture.fetchCount).toBe(1);

    const key2 = await fixture.generateKey('kid-2');
    const token2 = await fixture.signWith('kid-2', key2.privateKey, baseClaims());

    // Still within the cooldown window from the initial fetch: must NOT refetch, so the still-
    // cached (kid1-only) set can't find kid-2 and the call is rejected.
    await expect(verifier.verifyAccessToken(token2)).rejects.toBeInstanceOf(TokenVerificationError);
    expect(fixture.fetchCount).toBe(1);

    // Past the cooldown: now a rotated key DOES trigger exactly one refetch, and succeeds.
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS + 50));
    fixture.rotate('kid-2', key2.publicJwk);
    const claims = await verifier.verifyAccessToken(token2);

    expect(claims.sub).toBe('user-123');
    expect(fixture.fetchCount).toBe(2);
  });

  it('honours the refetch cooldown: a second unknown kid right after a refetch does not refetch again', async () => {
    const verifier = new JwksVerifierService(configFor(fixture));
    await verifier.verifyAccessToken(await fixture.signWith(kid1, key1.privateKey, baseClaims()));

    await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS + 50));
    const key2 = await fixture.generateKey('kid-2');
    fixture.rotate('kid-2', key2.publicJwk);
    await verifier.verifyAccessToken(
      await fixture.signWith('kid-2', key2.privateKey, baseClaims()),
    );
    const fetchesAfterRotation = fixture.fetchCount;
    expect(fetchesAfterRotation).toBe(2);

    // A third, still-unknown kid, immediately after the rotation refetch — must NOT trigger
    // another refetch: the cache (now kid-2 only) just became fresh again.
    const key3 = await fixture.generateKey('kid-3');
    const token3 = await fixture.signWith('kid-3', key3.privateKey, baseClaims());
    await expect(verifier.verifyAccessToken(token3)).rejects.toBeInstanceOf(TokenVerificationError);
    expect(fixture.fetchCount).toBe(fetchesAfterRotation);

    // Past the cooldown, a legitimately rotated key DOES trigger a refetch.
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS + 50));
    fixture.rotate('kid-3', key3.publicJwk);
    const claims = await verifier.verifyAccessToken(token3);

    expect(claims.sub).toBe('user-123');
    expect(fixture.fetchCount).toBe(fetchesAfterRotation + 1);
  });

  it('never logs the raw token', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    const verifier = new JwksVerifierService(configFor(fixture));
    const token = await fixture.signWith(kid1, key1.privateKey, baseClaims(), -10);

    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(TokenExpiredError);

    for (const call of warnSpy.mock.calls) {
      expect(call.join(' ')).not.toContain(token);
    }
  });

  // domain-review vòng 2 #4: a network/parse failure fetching the JWKS is NOT the same case as a
  // known-but-unpublished kid (fetches fine, key just isn't in the set) — both must fail closed.
  it('fails closed, without crashing or hanging, when the JWKS endpoint is unreachable', async () => {
    const token = await fixture.signWith(kid1, key1.privateKey, baseClaims());
    await fixture.close(); // the fetch below cannot succeed: connection refused, not a 4xx/5xx.

    const verifier = new JwksVerifierService(configFor(fixture));

    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });
});
