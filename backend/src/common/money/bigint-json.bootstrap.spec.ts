import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('bigint-json.bootstrap (DBS-22)', () => {
  afterEach(() => {
    delete BigInt.prototype.toJSON;
  });

  it('TC-22-24 importing the bootstrap file is enough to make bigint JSON-safe', async () => {
    delete BigInt.prototype.toJSON;
    expect(() => JSON.stringify(1n)).toThrow(TypeError);

    // A fresh module registry, so the file really runs now even if an earlier import cached it.
    await jest.isolateModulesAsync(async () => {
      await import('./bigint-json.bootstrap');
    });

    expect(JSON.stringify(2n ** 53n + 1n)).toBe('"9007199254740993"');
  });

  it('TC-22-26 (BL-009) a real APP_ROLE=worker process serializes nested bigint payloads without configureHttpApp', () => {
    const output = execFileSync(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        '-r',
        'tsconfig-paths/register',
        '-e',
        `require('./src/config/env.bootstrap');
         require('@common/money/bigint-json.bootstrap');
         const payload = {
           role: process.env.APP_ROLE,
           amount: 9007199254740993n,
           nested: { balanceAfter: 9223372036854775807n },
         };
         process.stdout.write(JSON.stringify(payload));`,
      ],
      {
        cwd: resolve(__dirname, '../../..'),
        env: { ...process.env, NODE_ENV: 'test', APP_ROLE: 'worker' },
        encoding: 'utf8',
      },
    );

    expect(JSON.parse(output)).toEqual({
      role: 'worker',
      amount: '9007199254740993',
      nested: { balanceAfter: '9223372036854775807' },
    });
  });
});
