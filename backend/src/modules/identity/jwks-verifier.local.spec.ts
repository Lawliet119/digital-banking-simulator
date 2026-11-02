import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT,
  type JWK,
  type KeyLike,
} from 'jose';
import { LOCAL_CLIENT_ID, LOCAL_ISSUER } from '@config/auth-local';
import { authConfig } from '@config/auth.config';
import { ConfigValidationError } from '@config/validation.schema';
import { TokenExpiredError, TokenVerificationError } from './identity.errors';
import { JwksVerifierService } from './jwks-verifier.service';
import { ROLES } from './roles';

/**
 * AUTH_MODE=local (DBS-53): the verifier reads its keys from a file instead of Cognito's JWKS URL.
 * Keys are made here with jose, like the sibling spec: a module's internals never import from
 * `src/scripts`, so the round trip with the real `auth:dev-keys` output (generateDevKeys -> file ->
 * this verifier) is tested in src/scripts/dev-auth.spec.ts.
 */
interface DevKey {
  privateKey: KeyLike;
  publicJwk: JWK & { kid: string };
}

async function newKey(): Promise<DevKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  return { privateKey, publicJwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

function sign(
  key: DevKey,
  claims: Record<string, unknown> = {},
  times: { iat?: number; exp?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: 'dev-operator',
    iss: LOCAL_ISSUER,
    client_id: LOCAL_CLIENT_ID,
    token_use: 'access',
    'cognito:groups': ['operator'],
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: key.publicJwk.kid })
    .setIssuedAt(times.iat ?? now)
    .setExpirationTime(times.exp ?? now + 900)
    .sign(key.privateKey);
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbs-53-verifier-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function writeJwks(content: unknown): string {
  const path = join(dir, 'jwks.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

function localConfig(jwksPath: string, jwksUri?: string): ConfigType<typeof authConfig> {
  return {
    local: { jwksPath },
    cognito: {
      userPoolId: undefined,
      clientId: LOCAL_CLIENT_ID,
      issuer: LOCAL_ISSUER,
      jwksUri,
      jwksCooldownMs: 200,
    },
    accessTokenTtlSeconds: 900,
  };
}

describe('JwksVerifierService in AUTH_MODE=local (DBS-53)', () => {
  let key: DevKey;

  beforeAll(async () => {
    key = await newKey();
  });

  function verifier(content: unknown = { keys: [key.publicJwk] }, jwksUri?: string) {
    return new JwksVerifierService(localConfig(writeJwks(content), jwksUri));
  }

  it.each(ROLES)('TC-53-21 accepts a token for %s and returns its claims', async role => {
    const claims = await verifier().verifyAccessToken(
      await sign(key, { sub: `dev-${role}`, 'cognito:groups': [role] }),
    );
    expect(claims).toMatchObject({
      sub: `dev-${role}`,
      iss: LOCAL_ISSUER,
      client_id: LOCAL_CLIENT_ID,
      token_use: 'access',
      'cognito:groups': [role],
    });
  });

  it('TC-53-22 rejects a token signed by any other key, even with the same kid', async () => {
    const other = await newKey();
    const sameKid = { ...other, publicJwk: { ...other.publicJwk, kid: key.publicJwk.kid } };
    const v = verifier();
    await expect(v.verifyAccessToken(await sign(other))).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
    await expect(v.verifyAccessToken(await sign(sameKid))).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });

  it('TC-53-23 reports an expired token as TokenExpiredError, not as a bad signature', async () => {
    const old = Math.floor(Date.now() / 1000) - 7200;
    const token = await sign(key, {}, { iat: old, exp: old + 900 });
    await expect(verifier().verifyAccessToken(token)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it.each([
    ['a wrong iss', { iss: 'https://cognito-idp.ap-southeast-1.amazonaws.com/pool' }],
    ['a wrong client_id', { client_id: 'some-cognito-client' }],
    ['token_use id', { token_use: 'id' }],
    ['no client_id', { client_id: undefined }],
  ])('TC-53-24 rejects %s even though the signature is right', async (_label, claims) => {
    await expect(verifier().verifyAccessToken(await sign(key, claims))).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });

  it('TC-53-25 rejects alg none and an HS256 token keyed with the public modulus', async () => {
    const v = verifier();
    const unsigned = new UnsecuredJWT({
      sub: 'dev-admin',
      iss: LOCAL_ISSUER,
      client_id: LOCAL_CLIENT_ID,
      token_use: 'access',
      'cognito:groups': ['admin'],
    })
      .setIssuedAt()
      .setExpirationTime('15m')
      .encode();
    await expect(v.verifyAccessToken(unsigned)).rejects.toBeInstanceOf(TokenVerificationError);

    const hmac = await new SignJWT({
      sub: 'dev-admin',
      iss: LOCAL_ISSUER,
      client_id: LOCAL_CLIENT_ID,
      token_use: 'access',
    })
      .setProtectedHeader({ alg: 'HS256', kid: key.publicJwk.kid })
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(key.publicJwk.n));
    await expect(v.verifyAccessToken(hmac)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  describe('TC-53-26 a bad key file stops the app at startup, naming only the setting', () => {
    const SECRET_MARKER = 'sensitive-file-content';

    function startupFailure(make: () => JwksVerifierService): ConfigValidationError {
      try {
        make();
      } catch (error) {
        return error as ConfigValidationError;
      }
      throw new Error('expected the constructor to throw');
    }

    it.each([
      [
        'a missing file',
        () => new JwksVerifierService(localConfig(join(dir, 'nope', 'jwks.json'))),
      ],
      ['broken JSON', () => verifier(`{ "keys": ${SECRET_MARKER}`)],
      ['an empty object', () => verifier({})],
      ['an empty key list', () => verifier({ keys: [] })],
      ['keys that is not a list', () => verifier({ keys: { kty: 'RSA' } })],
      ['a key that is not RSA', () => verifier({ keys: [{ kty: 'oct', k: SECRET_MARKER }] })],
      ['a non-key entry', () => verifier({ keys: ['x', null] })],
    ])('refuses %s', (_label, make) => {
      const error = startupFailure(make);
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.invalidKeys).toEqual(['AUTH_LOCAL_JWKS_PATH']);
      expect(error.message).not.toContain(SECRET_MARKER);
      expect(error.message).not.toContain(dir);
    });

    it.each(['d', 'p', 'q', 'dp', 'dq', 'qi'])(
      'refuses a JWKS that carries the private component %s',
      part => {
        const error = startupFailure(() =>
          verifier({ keys: [{ ...key.publicJwk, [part]: SECRET_MARKER }] }),
        );
        expect(error.invalidKeys).toEqual(['AUTH_LOCAL_JWKS_PATH']);
        expect(error.message).not.toContain(SECRET_MARKER);
      },
    );
  });

  it('TC-53-27 never calls the network, even when a JWKS URI is also configured', async () => {
    let fetches = 0;
    const server: Server = createServer((_req, res) => {
      fetches += 1;
      res.end(JSON.stringify({ keys: [] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const v = verifier({ keys: [key.publicJwk] }, `http://127.0.0.1:${port}/jwks.json`);
      await expect(v.verifyAccessToken(await sign(key))).resolves.toMatchObject({
        sub: 'dev-operator',
      });
      await expect(v.verifyAccessToken(await sign(await newKey()))).rejects.toBeInstanceOf(
        TokenVerificationError,
      );
      expect(fetches).toBe(0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('TC-53-28 logs one warning that the local key is accepted, without the path', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    verifier();
    const lines = warn.mock.calls.map(call => String(call[0]));
    expect(lines.filter(line => line.includes('AUTH_MODE=local'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(dir);
  });
});
