import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const backend = resolve(__dirname, '..');
const example = parse(readFileSync(resolve(backend, 'env/.env.example')));

/** Runs the real entrypoint in a subprocess and parses every line it prints as JSON. */
function runMain(overrides: Record<string, string>, withCrashPreload = false) {
  const result = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register',
      '-r',
      'tsconfig-paths/register',
      ...(withCrashPreload ? ['-r', './test/support/crash-preload.ts'] : []),
      'src/main.ts',
    ],
    {
      cwd: backend,
      encoding: 'utf8',
      timeout: 25_000,
      env: {
        ...process.env,
        ...example,
        NODE_ENV: 'test',
        TS_NODE_TRANSPILE_ONLY: 'true',
        LOG_LEVEL: 'debug',
        ...overrides,
      },
    },
  );
  expect(result.error).toBeUndefined();
  const output = result.stdout + result.stderr;
  const rows = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
  return { result, output, rows };
}

describe('DBS-42 bootstrap failure logging (real subprocess)', () => {
  it.each([
    ['api invalid config', { APP_ROLE: 'api', PORT: 'sensitive-port-fixture' }],
    ['worker invalid config', { APP_ROLE: 'worker', PORT: 'sensitive-port-fixture' }],
    ['invalid role', { APP_ROLE: 'sensitive-role-fixture' }],
    [
      'worker DB failure',
      { APP_ROLE: 'worker', DATABASE_URL: 'postgres://u:sensitive-db-fixture@127.0.0.1:1/banking' },
    ],
  ])(
    'TC-42-11 %s exits with sanitized JSON only',
    (_label, overrides) => {
      const { result, output, rows } = runMain(overrides);
      expect(result.status).not.toBe(0);
      expect(output).not.toContain('sensitive-');
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toMatchObject({
          level: expect.any(Number),
          time: expect.any(String),
          message: expect.any(String),
          correlationId: null,
        });
        expect(['api', 'worker']).toContain(row.role);
        expect(row.time).toMatch(/Z$/);
      }
      expect(rows.some(row => row.message === 'Application startup failed')).toBe(true);
      if (overrides.APP_ROLE === 'worker')
        expect(rows.every(row => row.role === 'worker')).toBe(true);
    },
    30_000,
  );

  it.each([
    [
      'two invalid keys, in schema order',
      { APP_ROLE: 'api', PORT: 'sensitive-port-fixture', LOG_LEVEL: 'INFO' },
      ['PORT', 'LOG_LEVEL'],
    ],
    [
      'the transfer limits that contradict each other',
      {
        APP_ROLE: 'api',
        TRANSFER_LIMIT_PER_TX: '987654321098',
        TRANSFER_LIMIT_PER_DAY: '123456789012',
      },
      ['<cross-field>'],
    ],
    [
      'a value that the validation message itself quotes',
      { APP_ROLE: 'api', TRANSFER_LIMIT_PER_TX: 'sensitive-limit-fixture' },
      ['TRANSFER_LIMIT_PER_TX'],
    ],
    ['an unknown APP_ROLE', { APP_ROLE: 'sensitive-role-fixture' }, ['APP_ROLE']],
  ])(
    'TC-42-11 reports %s by key name and never by value',
    (_label, overrides, expectedKeys) => {
      const { result, output, rows } = runMain(overrides);
      expect(result.status).not.toBe(0);
      const failed = rows.find(row => row.message === 'Application startup failed');
      expect(failed?.invalidKeys).toEqual(expectedKeys);
      for (const value of ['sensitive-', '987654321098', '123456789012'])
        expect(output).not.toContain(value);
    },
    30_000,
  );

  it.each([
    ['api', 'uncaught', 'Uncaught exception'],
    ['api', 'unhandled', 'Unhandled promise rejection'],
    ['worker', 'uncaught', 'Uncaught exception'],
    ['worker', 'unhandled', 'Unhandled promise rejection'],
  ] as const)(
    'TC-42-11 %s %s crash ends as one JSON fatal line, no stack text and no stderr',
    (role, kind, message) => {
      const { result, output, rows } = runMain({ APP_ROLE: role, DBS42_CRASH: kind }, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(output).not.toContain('sensitive-');
      expect(output).not.toContain('    at ');
      // Every line is a JSON record: no empty line before the fatal one.
      expect(result.stdout.split(String.fromCharCode(10)).slice(0, -1).every(Boolean)).toBe(true);
      const fatal = rows.filter(row => row.level === 60);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]).toMatchObject({
        role: role === 'worker' ? 'worker' : 'api',
        correlationId: null,
        message,
        errorType: 'Error',
      });
    },
    30_000,
  );
});
