import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const backend = resolve(__dirname, '..');
const example = parse(readFileSync(resolve(backend, 'env/.env.example')));

/** A fully valid deployed environment, so the only thing that can fail is what a test adds. */
const deployed = {
  DATABASE_URL: 'postgres://u:p@db.internal:5432/banking',
  DATABASE_SSL: 'true',
  REDIS_URL: 'rediss://cache.internal:6379',
  TRUST_PROXY_HOPS: '1',
  COGNITO_USER_POOL_ID: 'ap-southeast-1_abc',
  COGNITO_CLIENT_ID: 'client-id',
  COGNITO_ISSUER: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_abc',
};

/** A path nobody would guess, so "the output does not contain it" proves something. */
const MARKER_PATH = 'sensitive-keys-fixture/jwks.json';

type Row = Record<string, unknown>;

/** Runs the real entrypoint in a subprocess, as test/logging-bootstrap.e2e-spec.ts does. */
function runMain(overrides: Record<string, string>) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...example,
    TS_NODE_TRANSPILE_ONLY: 'true',
    LOG_LEVEL: 'debug',
    ...overrides,
  };
  // The parent's own settings must not leak into the case under test.
  for (const name of ['AUTH_MODE', 'AUTH_LOCAL_JWKS_PATH']) {
    if (!(name in overrides)) delete env[name];
  }
  const result = spawnSync(
    process.execPath,
    ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', 'src/main.ts'],
    { cwd: backend, encoding: 'utf8', timeout: 25_000, env },
  );
  expect(result.error).toBeUndefined();
  const output = result.stdout + result.stderr;
  const rows = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Row);
  const failure = rows.find(row => row.message === 'Application startup failed');
  return { result, output, rows, failure };
}

function expectRefused(run: ReturnType<typeof runMain>, invalidKeys: string[]): void {
  expect(run.result.status).not.toBe(0);
  expect(run.failure).toBeDefined();
  expect(run.failure?.invalidKeys).toEqual(invalidKeys);
  // Never serves: no listener line, and the path the operator typed is not echoed.
  expect(run.rows.some(row => row.message === 'HTTP listener started')).toBe(false);
  expect(run.output).not.toContain('sensitive-keys-fixture');
}

describe('DBS-53 local auth is refused outside development and test (real process)', () => {
  it('control: the deployed environment alone passes validation', () => {
    // It then fails to reach the database, which is unrelated: what matters is that the
    // configuration itself is not what stopped it.
    const run = runMain({ ...deployed, NODE_ENV: 'production', APP_ROLE: 'api' });
    expect(run.failure?.invalidKeys).toBeUndefined();
  });

  it('TC-53-11 production with AUTH_MODE=local exits with a JSON error naming the two settings', () => {
    const run = runMain({
      ...deployed,
      NODE_ENV: 'production',
      APP_ROLE: 'api',
      AUTH_MODE: 'local',
      AUTH_LOCAL_JWKS_PATH: MARKER_PATH,
    });
    expectRefused(run, ['AUTH_MODE', 'AUTH_LOCAL_JWKS_PATH']);
  });

  it('TC-53-12 staging with only a key path exits naming exactly that setting', () => {
    const run = runMain({
      ...deployed,
      NODE_ENV: 'staging',
      APP_ROLE: 'api',
      AUTH_LOCAL_JWKS_PATH: MARKER_PATH,
    });
    expectRefused(run, ['AUTH_LOCAL_JWKS_PATH']);
  });

  it('TC-53-12b local mode with a key file that is missing stops the app, naming only the setting', () => {
    // A port that refuses connections keeps the run short and independent of any Postgres.
    const run = runMain({
      NODE_ENV: 'test',
      APP_ROLE: 'api',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/banking',
      AUTH_MODE: 'local',
      AUTH_LOCAL_JWKS_PATH: MARKER_PATH,
    });
    expectRefused(run, ['AUTH_LOCAL_JWKS_PATH']);
  });
});
