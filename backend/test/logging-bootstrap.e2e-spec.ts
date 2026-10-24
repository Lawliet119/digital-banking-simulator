import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

describe('DBS-42 bootstrap failure logging (real subprocess)', () => {
  const backend = resolve(__dirname, '..');
  const example = parse(readFileSync(resolve(backend, 'env/.env.example')));

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
      const result = spawnSync(
        process.execPath,
        ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', 'src/main.ts'],
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
      expect(result.status).not.toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).not.toContain('sensitive-');
      const lines = output.trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const rows = lines.map(line => JSON.parse(line) as Record<string, unknown>);
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
});
