import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
  type JWK,
} from 'jose';
import { LOCAL_CLIENT_ID, LOCAL_ISSUER } from '@config/auth-local';
import { JwksVerifierService, ROLES, TokenVerificationError } from '@modules/identity';
import {
  generateDevKeys,
  mintDevToken,
  parseKeysArgs,
  parseTokenArgs,
  runKeysCli,
  runTokenCli,
} from './dev-auth';

const PRIVATE_PARTS = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbs-53-keys-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readJwks(): { keys: JWK[] } {
  return JSON.parse(readFileSync(join(dir, 'jwks.json'), 'utf8')) as { keys: JWK[] };
}

describe('generateDevKeys (TC-53-13, TC-53-14)', () => {
  it('TC-53-13 writes a private key and a JWKS that holds the public half only', async () => {
    const result = await generateDevKeys({ dir });

    expect(result.privateKeyPath).toBe(join(dir, 'private.pem'));
    expect(result.jwksPath).toBe(join(dir, 'jwks.json'));
    expect(readFileSync(join(dir, 'private.pem'), 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);

    const { keys } = readJwks();
    expect(keys).toHaveLength(1);
    const [key] = keys;
    expect(key).toMatchObject({ kty: 'RSA', e: 'AQAB', alg: 'RS256', use: 'sig' });
    for (const part of PRIVATE_PARTS) expect(key).not.toHaveProperty(part);

    const { kid, ...withoutKid } = key;
    expect(kid).toBe(await calculateJwkThumbprint(withoutKid));
    expect(result.kid).toBe(kid);
  });

  it('TC-53-14 refuses to overwrite existing keys, and --force replaces both files', async () => {
    const first = await generateDevKeys({ dir });
    const privateBefore = readFileSync(join(dir, 'private.pem'), 'utf8');
    const jwksBefore = readFileSync(join(dir, 'jwks.json'), 'utf8');

    await expect(generateDevKeys({ dir })).rejects.toThrow(/--force/);
    expect(readFileSync(join(dir, 'private.pem'), 'utf8')).toBe(privateBefore);
    expect(readFileSync(join(dir, 'jwks.json'), 'utf8')).toBe(jwksBefore);

    const second = await generateDevKeys({ dir, force: true });
    expect(second.kid).not.toBe(first.kid);
    expect(readFileSync(join(dir, 'private.pem'), 'utf8')).not.toBe(privateBefore);
    expect(readJwks().keys[0].kid).toBe(second.kid);
  });

  it('refuses when only one of the two files is left over', async () => {
    writeFileSync(join(dir, 'jwks.json'), '{}');
    await expect(generateDevKeys({ dir })).rejects.toThrow(/--force/);
    expect(existsSync(join(dir, 'private.pem'))).toBe(false);
  });
});

describe('mintDevToken (TC-53-15, TC-53-16)', () => {
  it.each(ROLES)('TC-53-15 signs a verifiable access token for %s', async role => {
    await generateDevKeys({ dir });
    const token = await mintDevToken({ dir, role });

    const header = decodeProtectedHeader(token);
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: readJwks().keys[0].kid });

    // Verified against the published JWKS, the way the app will do it.
    const { payload } = await jwtVerify(token, createLocalJWKSet(readJwks()), {
      issuer: LOCAL_ISSUER,
      algorithms: ['RS256'],
    });
    expect(payload).toMatchObject({
      sub: `dev-${role}`,
      iss: LOCAL_ISSUER,
      client_id: LOCAL_CLIENT_ID,
      token_use: 'access',
      'cognito:groups': [role],
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(900);
    expect(typeof payload.jti).toBe('string');
  });

  it('TC-53-15 gives each token its own jti', async () => {
    await generateDevKeys({ dir });
    const a = decodeJwt(await mintDevToken({ dir, role: 'admin' }));
    const b = decodeJwt(await mintDevToken({ dir, role: 'admin' }));
    expect(a.jti).not.toBe(b.jti);
  });

  it('TC-53-16 honours a custom sub, iat and exp, including an iat in the past', async () => {
    await generateDevKeys({ dir });
    const token = await mintDevToken({
      dir,
      role: 'customer',
      sub: 'nguyen-van-an',
      iat: 1_700_000_000,
      exp: 1_700_000_300,
    });
    expect(decodeJwt(token)).toMatchObject({
      sub: 'nguyen-van-an',
      iat: 1_700_000_000,
      exp: 1_700_000_300,
      'cognito:groups': ['customer'],
    });
  });

  it('TC-53-16 derives exp from a custom iat when only iat is given', async () => {
    await generateDevKeys({ dir });
    const claims = decodeJwt(await mintDevToken({ dir, role: 'auditor', iat: 1_700_000_000 }));
    expect(claims.exp).toBe(1_700_000_900);
  });

  it('TC-53-17 refuses anything that is not one of the four roles, exactly', async () => {
    await generateDevKeys({ dir });
    for (const role of ['superadmin', 'Admin', 'ADMIN', ' admin', '', '__proto__']) {
      await expect(mintDevToken({ dir, role })).rejects.toThrow(/role/);
    }
  });

  it.each([
    ['exp equal to iat', { iat: 1000, exp: 1000 }],
    ['exp before iat', { iat: 1000, exp: 999 }],
    ['a fractional iat', { iat: 1000.5 }],
    ['a negative iat', { iat: -1 }],
    ['a non-finite exp', { exp: Number.POSITIVE_INFINITY }],
    ['an empty sub', { sub: '' }],
    ['a 129 character sub', { sub: 'a'.repeat(129) }],
    ['a sub with a control character', { sub: 'an\nbinh' }],
    ['a sub with a NUL', { sub: 'an\u0000binh' }],
  ])('TC-53-17 refuses %s and signs nothing', async (_label, override) => {
    await generateDevKeys({ dir });
    await expect(mintDevToken({ dir, role: 'operator', ...override })).rejects.toThrow();
  });

  it('TC-53-17 accepts a 128 character sub', async () => {
    await generateDevKeys({ dir });
    const sub = 'a'.repeat(128);
    expect(decodeJwt(await mintDevToken({ dir, role: 'operator', sub })).sub).toBe(sub);
  });

  it('TC-53-20 names auth:dev-keys when there is no private key yet', async () => {
    await expect(mintDevToken({ dir, role: 'operator' })).rejects.toThrow(/auth:dev-keys/);
  });
});

describe('argument parsing (TC-53-18)', () => {
  it('reads every flag of auth:dev-token', () => {
    expect(
      parseTokenArgs([
        '--role',
        'operator',
        '--sub',
        'le-thi-hoa',
        '--iat',
        '1700000000',
        '--exp',
        '1700000900',
        '--dir',
        'keys',
      ]),
    ).toEqual({
      role: 'operator',
      sub: 'le-thi-hoa',
      iat: 1_700_000_000,
      exp: 1_700_000_900,
      dir: 'keys',
    });
  });

  it.each([
    ['no --role', []],
    ['an unknown flag', ['--role', 'admin', '--admin']],
    ['a flag without a value', ['--role']],
    ['a flag followed by another flag', ['--role', '--sub', 'x']],
    ['a repeated flag', ['--role', 'admin', '--role', 'operator']],
    ['a non-numeric --iat', ['--role', 'admin', '--iat', 'yesterday']],
    ['a fractional --exp', ['--role', 'admin', '--exp', '1.5']],
    ['a bare word', ['admin']],
  ])('refuses %s', (_label, argv) => {
    expect(() => parseTokenArgs(argv)).toThrow();
  });

  it('reads the flags of auth:dev-keys and refuses unknown ones', () => {
    expect(parseKeysArgs([])).toEqual({ force: false });
    expect(parseKeysArgs(['--force', '--dir', 'keys'])).toEqual({ force: true, dir: 'keys' });
    expect(() => parseKeysArgs(['--forse'])).toThrow();
  });
});

describe('command line entry points (TC-53-19)', () => {
  function io(nodeEnv: string | undefined) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      options: {
        nodeEnv,
        cwd: dir,
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => err.push(text),
      },
    };
  }

  it.each(['staging', 'production', 'prod', 'Production', 'preview'])(
    'refuses both commands when NODE_ENV is %s, writes nothing and prints no token',
    async nodeEnv => {
      const keys = io(nodeEnv);
      expect(await runKeysCli([], keys.options)).toBe(1);
      expect(existsSync(join(dir, '.auth-local'))).toBe(false);
      expect(keys.out).toEqual([]);

      // Even with keys on disk, a deployed environment never gets a token.
      await generateDevKeys({ dir: join(dir, '.auth-local') });
      const token = io(nodeEnv);
      expect(await runTokenCli(['--role', 'admin'], token.options)).toBe(1);
      expect(token.out).toEqual([]);
      expect(token.err.join('')).toMatch(/NODE_ENV/);
    },
  );

  it.each([undefined, 'development', 'test'])('runs when NODE_ENV is %s', async nodeEnv => {
    const keys = io(nodeEnv);
    expect(await runKeysCli([], keys.options)).toBe(0);
    const token = io(nodeEnv);
    expect(await runTokenCli(['--role', 'admin'], token.options)).toBe(0);
    expect(token.out).toHaveLength(1);
  });

  it('auth:dev-keys prints the two env lines and tells the developer to comment COGNITO_* out', async () => {
    const keys = io('development');
    expect(await runKeysCli([], keys.options)).toBe(0);
    const text = keys.out.join('');
    expect(text).toContain('AUTH_MODE=local');
    expect(text).toContain('AUTH_LOCAL_JWKS_PATH=.auth-local/jwks.json');
    expect(text).toMatch(/COGNITO_\*/);
    expect(text).not.toContain('BEGIN PRIVATE KEY');
  });

  it('auth:dev-keys exits 1 and leaves the keys alone when they exist', async () => {
    const first = io('development');
    await runKeysCli([], first.options);
    const second = io('development');
    expect(await runKeysCli([], second.options)).toBe(1);
    expect(second.err.join('')).toMatch(/--force/);
    expect(await runKeysCli(['--force'], io('development').options)).toBe(0);
  });

  it('auth:dev-token prints exactly one line, the token, and nothing else on stdout', async () => {
    await runKeysCli([], io('test').options);
    const token = io('test');
    expect(await runTokenCli(['--role', 'auditor'], token.options)).toBe(0);
    expect(token.err).toEqual([]);
    const printed = token.out.join('');
    expect(printed).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+\n$/);
    expect(decodeJwt(printed.trim())['cognito:groups']).toEqual(['auditor']);
  });

  it('auth:dev-token leaves stdout empty and exits 1 on a bad argument or missing keys', async () => {
    const missing = io('test');
    expect(await runTokenCli(['--role', 'admin'], missing.options)).toBe(1);
    expect(missing.out).toEqual([]);
    expect(missing.err.join('')).toMatch(/auth:dev-keys/);

    await runKeysCli([], io('test').options);
    const bad = io('test');
    expect(await runTokenCli(['--role', 'root'], bad.options)).toBe(1);
    expect(bad.out).toEqual([]);
  });
});

describe('the two npm commands as real processes (TC-53-15, TC-53-19)', () => {
  const backend = resolve(__dirname, '../..');

  function run(entry: string, args: string[], nodeEnv: string | undefined) {
    const env: NodeJS.ProcessEnv = { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' };
    if (nodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = nodeEnv;
    return spawnSync(
      process.execPath,
      ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', `src/scripts/${entry}`, ...args],
      { cwd: backend, env, encoding: 'utf8', timeout: 60_000 },
    );
  }

  it('auth:dev-keys then auth:dev-token leave exactly one line, the token, on stdout', () => {
    const keys = run('dev-auth.keys.ts', ['--dir', dir], 'development');
    expect(keys.status).toBe(0);
    expect(existsSync(join(dir, 'private.pem'))).toBe(true);

    const token = run('dev-auth.token.ts', ['--role', 'operator', '--dir', dir], 'development');
    expect(token.status).toBe(0);
    expect(token.stderr).toBe('');
    expect(token.stdout).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+\n$/);
    expect(decodeJwt(token.stdout.trim())['cognito:groups']).toEqual(['operator']);
  });

  it.each(['staging', 'production', 'prod'])(
    'both entry points exit 1 for NODE_ENV=%s with nothing on stdout and no key written',
    nodeEnv => {
      const keys = run('dev-auth.keys.ts', ['--dir', join(dir, 'k')], nodeEnv);
      expect(keys.status).toBe(1);
      expect(keys.stdout).toBe('');
      expect(existsSync(join(dir, 'k'))).toBe(false);

      const token = run('dev-auth.token.ts', ['--role', 'admin', '--dir', dir], nodeEnv);
      expect(token.status).toBe(1);
      expect(token.stdout).toBe('');
    },
  );
});

describe('the keys stay out of git, the image and the production build (TC-53-32, TC-53-33)', () => {
  const backend = resolve(__dirname, '../..');
  const read = (...parts: string[]) => readFileSync(resolve(backend, ...parts), 'utf8');
  const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim());

  it('is gitignored (backend/.auth-local/)', () => {
    expect(lines(read('..', '.gitignore'))).toContain('backend/.auth-local/');
  });

  it('is dockerignored, and the Dockerfile copies neither it nor runs outside production', () => {
    expect(lines(read('.dockerignore'))).toContain('.auth-local');
    const dockerfile = read('Dockerfile');
    expect(dockerfile).not.toMatch(/auth-local/);
    expect(dockerfile).toMatch(/^ENV NODE_ENV=production$/m);
  });

  it('excludes the dev-auth scripts from the production build', () => {
    const build = JSON.parse(read('tsconfig.build.json')) as { exclude: string[] };
    expect(build.exclude).toContain('src/scripts/dev-auth*.ts');
  });

  it('has the two npm commands, run through ts-node like check:invariants', () => {
    const { scripts } = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(scripts['auth:dev-keys']).toMatch(/ts-node .*src\/scripts\/dev-auth\.keys\.ts/);
    expect(scripts['auth:dev-token']).toMatch(/ts-node .*src\/scripts\/dev-auth\.token\.ts/);
  });
});

describe('the README tells a developer how to get a token for Swagger (TC-53-33)', () => {
  const readme = readFileSync(resolve(__dirname, '../../README.md'), 'utf8');
  // Only the section DBS-53 adds, so a mention elsewhere cannot satisfy the test.
  const section = /### 10\. Token thử ở local[\s\S]*?(?=\n### |\n## |$)/.exec(readme)?.[0] ?? '';

  it('has a section for it', () => {
    expect(section).not.toBe('');
  });

  it.each([
    'npm run auth:dev-keys',
    'npm run --silent auth:dev-token',
    '--role',
    'AUTH_MODE=local',
    'AUTH_LOCAL_JWKS_PATH',
    'COGNITO_',
    'Authorize',
    '/docs',
    'khởi động lại',
  ])('mentions %s', needle => {
    expect(section).toContain(needle);
  });

  it('names all four roles and warns that staging and production refuse it', () => {
    for (const role of ROLES) expect(section).toContain(role);
    expect(section).toMatch(/staging/);
    expect(section).toMatch(/production/);
  });

  it('lists both commands in the command table', () => {
    expect(readme).toMatch(/\|\s*`npm run auth:dev-keys`/);
    expect(readme).toMatch(/\|\s*`npm run --silent auth:dev-token/);
  });
});

describe('what auth:dev-keys writes is what the verifier reads (TC-53-21)', () => {
  // The verifier spec makes its keys with jose, and a module's internals never import from
  // src/scripts, so the real round trip lives here: generateDevKeys -> jwks.json on disk ->
  // JwksVerifierService (through the module's public index) <- a token from mintDevToken.
  function verifierFor(jwksPath: string): JwksVerifierService {
    return new JwksVerifierService({
      local: { jwksPath },
      cognito: {
        userPoolId: undefined,
        clientId: LOCAL_CLIENT_ID,
        issuer: LOCAL_ISSUER,
        jwksUri: undefined,
        jwksCooldownMs: 200,
      },
      accessTokenTtlSeconds: 900,
    });
  }

  it.each(ROLES)('verifies a %s token minted from keys written by generateDevKeys', async role => {
    const keys = await generateDevKeys({ dir });
    const verifier = verifierFor(keys.jwksPath);

    const claims = await verifier.verifyAccessToken(await mintDevToken({ dir, role }));

    expect(claims).toMatchObject({ sub: `dev-${role}`, 'cognito:groups': [role] });
  });

  it('rejects a token minted from the keys that --force replaced', async () => {
    const first = await generateDevKeys({ dir });
    const staleToken = await mintDevToken({ dir, role: 'admin' });
    await generateDevKeys({ dir, force: true });

    // A verifier started after --force knows only the new key; the old token no longer passes.
    await expect(verifierFor(first.jwksPath).verifyAccessToken(staleToken)).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });
});
