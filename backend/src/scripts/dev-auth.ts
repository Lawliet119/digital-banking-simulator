import { createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  calculateJwkThumbprint,
  exportJWK,
  importPKCS8,
  SignJWT,
  type JWK,
  type KeyLike,
} from 'jose';
import { LOCAL_CLIENT_ID, LOCAL_ISSUER } from '@config/auth-local';
import { ROLES, type Role } from '@modules/identity';

/**
 * Development-only signing keys and sample tokens (DBS-53, ADR-06). Three things use this file:
 * the two npm commands (`auth:dev-keys`, `auth:dev-token`, via the `dev-auth.*.ts` entry points)
 * and the e2e helper, which signs with a key pair that never touches the disk.
 *
 * Everything under `src/scripts/dev-auth*` is left out of the production build
 * (tsconfig.build.json): the image must not carry a tool that mints tokens.
 */

export const DEFAULT_KEY_DIR = '.auth-local';
const PRIVATE_KEY_FILE = 'private.pem';
const JWKS_FILE = 'jwks.json';

/** Matches ACCESS_TOKEN_TTL_SECONDS' default, so a sample token behaves like a real one. */
export const DEFAULT_TOKEN_TTL_SECONDS = 900;
const MAX_SUB_LENGTH = 128;

/** An expected problem with what the developer typed or the state of the key directory. */
export class DevAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevAuthError';
  }
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

// ── Key generation ────────────────────────────────────────────────────────────────────────────

export interface GenerateOptions {
  /** Directory for the two files. Created when missing. */
  dir: string;
  /** Replace keys that already exist. Without it, existing keys are an error. */
  force?: boolean;
}

export interface GeneratedKeys {
  privateKeyPath: string;
  jwksPath: string;
  kid: string;
}

/** A new RSA key pair in memory, with the public half as a JWK carrying its thumbprint as `kid`. */
export async function newDevKeyPair(): Promise<{
  privateKey: KeyObject;
  publicJwk: JWK & { kid: string };
}> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, publicJwk: await publicJwkOf(publicKey) };
}

async function publicJwkOf(publicKey: KeyObject): Promise<JWK & { kid: string }> {
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  return { ...jwk, kid, alg: 'RS256', use: 'sig' };
}

export async function generateDevKeys(options: GenerateOptions): Promise<GeneratedKeys> {
  const privateKeyPath = join(options.dir, PRIVATE_KEY_FILE);
  const jwksPath = join(options.dir, JWKS_FILE);
  if (!options.force && (existsSync(privateKeyPath) || existsSync(jwksPath))) {
    throw new DevAuthError(
      `Dev keys already exist in ${options.dir}. They were not changed; pass --force to replace them.`,
    );
  }

  const { privateKey, publicJwk } = await newDevKeyPair();
  mkdirSync(options.dir, { recursive: true });
  // 0600 is best effort (it means little on Windows). The real protection is that the directory
  // is gitignored and dockerignored, and that a deployed environment refuses to load it.
  writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  writeFileSync(jwksPath, `${JSON.stringify({ keys: [publicJwk] }, null, 2)}\n`);
  return { privateKeyPath, jwksPath, kid: publicJwk.kid };
}

// ── Token minting ─────────────────────────────────────────────────────────────────────────────

export interface TokenClaimsOptions {
  role: string;
  /** Defaults to `dev-<role>`, stable so repeated runs reuse one `users` row. */
  sub?: string;
  /** Seconds since the epoch. Defaults to now. */
  iat?: number;
  /** Seconds since the epoch. Defaults to `iat + 900`. */
  exp?: number;
}

function assertEpoch(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DevAuthError(`${name} must be a whole number of seconds since the epoch (>= 0).`);
  }
}

/** Validates the options and returns the claims of an access token shaped like Cognito's. */
export function buildAccessTokenClaims(options: TokenClaimsOptions): Record<string, unknown> {
  if (!isRole(options.role)) {
    throw new DevAuthError(`role must be exactly one of: ${ROLES.join(', ')}.`);
  }
  const sub = options.sub ?? `dev-${options.role}`;
  if (sub.length === 0 || sub.length > MAX_SUB_LENGTH) {
    throw new DevAuthError(`sub must be 1 to ${MAX_SUB_LENGTH} characters.`);
  }
  // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
  if (/[\u0000-\u001f\u007f]/.test(sub)) {
    throw new DevAuthError('sub must not contain control characters.');
  }
  const iat = options.iat ?? Math.floor(Date.now() / 1000);
  assertEpoch('iat', iat);
  const exp = options.exp ?? iat + DEFAULT_TOKEN_TTL_SECONDS;
  assertEpoch('exp', exp);
  if (exp <= iat) {
    throw new DevAuthError('exp must be later than iat.');
  }
  return {
    sub,
    iss: LOCAL_ISSUER,
    client_id: LOCAL_CLIENT_ID,
    token_use: 'access',
    'cognito:groups': [options.role],
    jti: randomUUID(),
    iat,
    exp,
  };
}

/** Signs with a key already in memory (the e2e helper uses this directly). */
export async function signDevToken(
  privateKey: KeyLike,
  kid: string,
  options: TokenClaimsOptions,
): Promise<string> {
  const { iat, exp, ...claims } = buildAccessTokenClaims(options);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
    .setIssuedAt(iat as number)
    .setExpirationTime(exp as number)
    .sign(privateKey);
}

export interface MintOptions extends TokenClaimsOptions {
  dir: string;
}

/** Signs a token with the private key that `auth:dev-keys` wrote to `dir`. */
export async function mintDevToken(options: MintOptions): Promise<string> {
  buildAccessTokenClaims(options); // fail on bad input before touching the disk
  const privateKeyPath = join(options.dir, PRIVATE_KEY_FILE);
  if (!existsSync(privateKeyPath)) {
    throw new DevAuthError(`No dev private key in ${options.dir}. Run: npm run auth:dev-keys`);
  }
  const pem = readFileSync(privateKeyPath, 'utf8');
  const privateKey = await importPKCS8(pem, 'RS256');
  // The kid is the thumbprint of the public half, so it is derived here, not read from jwks.json.
  const { kid } = await publicJwkOf(createPublicKey(pem));
  return signDevToken(privateKey, kid, options);
}

// ── Command line ──────────────────────────────────────────────────────────────────────────────

export interface TokenArgs {
  role: string;
  sub?: string;
  iat?: number;
  exp?: number;
  dir?: string;
}

export interface KeysArgs {
  force: boolean;
  dir?: string;
}

function readFlags(argv: string[], valueFlags: string[], switchFlags: string[]) {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (switchFlags.includes(flag)) {
      switches.add(flag);
    } else if (valueFlags.includes(flag)) {
      if (values.has(flag)) throw new DevAuthError(`${flag} was given twice.`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new DevAuthError(`${flag} needs a value.`);
      }
      values.set(flag, value);
      i += 1;
    } else {
      throw new DevAuthError(`Unknown argument: ${flag}`);
    }
  }
  return { values, switches };
}

function toEpoch(flag: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) {
    throw new DevAuthError(`${flag} must be a whole number of seconds since the epoch.`);
  }
  return Number(text);
}

export function parseTokenArgs(argv: string[]): TokenArgs {
  const { values } = readFlags(argv, ['--role', '--sub', '--iat', '--exp', '--dir'], []);
  const role = values.get('--role');
  if (role === undefined) {
    throw new DevAuthError(`--role is required: one of ${ROLES.join(', ')}.`);
  }
  return {
    role,
    sub: values.get('--sub'),
    iat: toEpoch('--iat', values.get('--iat')),
    exp: toEpoch('--exp', values.get('--exp')),
    dir: values.get('--dir'),
  };
}

export function parseKeysArgs(argv: string[]): KeysArgs {
  const { values, switches } = readFlags(argv, ['--dir'], ['--force']);
  return { force: switches.has('--force'), dir: values.get('--dir') };
}

export interface CliIo {
  /** `process.env.NODE_ENV` as the shell gave it. */
  nodeEnv: string | undefined;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * Allow-list, not block-list: only a development or test shell (or none at all) may mint keys
 * and tokens. `prod`, `Production` or any value the app itself would not accept are refused too.
 */
function assertLocalEnvironment(nodeEnv: string | undefined): void {
  if (nodeEnv !== undefined && nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new DevAuthError(
      'Refusing to run: NODE_ENV must be development, test or unset. Local test keys are never used elsewhere.',
    );
  }
}

function keyDirectory(io: CliIo, dir: string | undefined): string {
  return resolve(io.cwd, dir ?? DEFAULT_KEY_DIR);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error.';
}

export async function runKeysCli(argv: string[], io: CliIo): Promise<number> {
  try {
    assertLocalEnvironment(io.nodeEnv);
    const args = parseKeysArgs(argv);
    const keys = await generateDevKeys({ dir: keyDirectory(io, args.dir), force: args.force });
    const shown = (path: string) => relative(io.cwd, path).split(sep).join('/');
    io.stdout(
      [
        `Dev keys written (kid ${keys.kid}):`,
        `  ${shown(keys.privateKeyPath)}   private key, gitignored: never commit it`,
        `  ${shown(keys.jwksPath)}   public key set`,
        '',
        'Put these two lines in env/.env.development:',
        '  AUTH_MODE=local',
        `  AUTH_LOCAL_JWKS_PATH=${shown(keys.jwksPath)}`,
        '',
        'AUTH_MODE=local forbids COGNITO_*: comment out every COGNITO_* line in that file,',
        'otherwise the app refuses to start. Restart the app after changing the keys.',
        '',
        'Get a token:  npm run --silent auth:dev-token -- --role operator',
        '',
      ].join('\n'),
    );
    return 0;
  } catch (error) {
    io.stderr(`${messageOf(error)}\n`);
    return 1;
  }
}

export async function runTokenCli(argv: string[], io: CliIo): Promise<number> {
  try {
    assertLocalEnvironment(io.nodeEnv);
    const args = parseTokenArgs(argv);
    const token = await mintDevToken({ ...args, dir: keyDirectory(io, args.dir) });
    io.stdout(`${token}\n`); // stdout is the token and nothing else: `$(npm run --silent …)` works
    return 0;
  } catch (error) {
    io.stderr(`${messageOf(error)}\n`);
    return 1;
  }
}
