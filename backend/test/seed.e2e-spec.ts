import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDevKeys } from '../src/scripts/dev-auth';
import {
  formatReport,
  parseCliArgs,
  planBalanceTrail,
  resolveTokens,
  runSeedCli,
  SEED_STEP_SKIPPED,
  SeedError,
  type SeedReport,
} from '../src/scripts/seed';
import {
  resolveTokens as coreResolveTokens,
  runSeedCli as coreRunSeedCli,
} from '../src/scripts/seed-core';

const TOKEN_ENV = [
  'DBS_OPERATOR_TOKEN',
  'DBS_CUSTOMER_1_TOKEN',
  'DBS_CUSTOMER_2_TOKEN',
  'DBS_CUSTOMER_3_TOKEN',
] as const;

describe('DBS-70 Demo Data Seed CLI (offline e2e)', () => {
  describe('BL-213 balance plan', () => {
    it('TC-70-04g lists the balances each account passes through and where each transfer lands', () => {
      const { trails, transferPositions } = planBalanceTrail();
      expect(trails.get('demo-customer-minh-anh:CHECKING')).toEqual([0n, 50000000n, 48000000n]);
      expect(trails.get('demo-customer-minh-anh:SAVINGS')).toEqual([0n, 20000000n]);
      expect(trails.get('demo-customer-thu-ha:CHECKING')).toEqual([
        0n,
        10000000n,
        12000000n,
        11500000n,
      ]);
      expect(trails.get('demo-customer-van-binh:CHECKING')).toEqual([0n, 5000000n, 5500000n]);
      expect(transferPositions).toEqual([
        { from: 2, to: 2 },
        { from: 3, to: 2 },
      ]);
    });

    it('TC-70-04h shows a skipped step in the report instead of a transfer id', () => {
      const report: SeedReport = {
        baseUrl: 'http://127.0.0.1:3000',
        customers: [],
        deposits: [
          {
            toAccountId: '22222222-2222-4222-8222-222222222222',
            amount: '50000000',
            transferId: null,
            status: SEED_STEP_SKIPPED,
            skipped: true,
          },
        ],
        transfers: [
          {
            fromAccountId: '22222222-2222-4222-8222-222222222222',
            toAccountId: '44444444-4444-4444-8444-444444444444',
            amount: '2000000',
            transferId: null,
            status: SEED_STEP_SKIPPED,
            skipped: true,
          },
        ],
      };
      const formatted = formatReport(report);
      expect(formatted).not.toContain('null');
      expect(formatted.match(/skipped \(balance already reflects it\)/g)).toHaveLength(2);
    });
  });

  describe('CLI arguments parsing', () => {
    it('TC-70-04a parses default arguments', () => {
      const args = parseCliArgs([]);
      expect(args.help).toBe(false);
      expect(args.quiet).toBe(false);
      expect(args.authMode).toBe('local');
      expect(args.baseUrl).toBe('http://127.0.0.1:3000');
    });

    it('TC-70-04b parses custom flags and cloud tokens', () => {
      const args = parseCliArgs([
        '--url',
        'http://api.dbs.internal:8080',
        '--auth',
        'cloud',
        '--operator-token',
        'op-jwt',
        '--customer1-token',
        'c1-jwt',
        '--customer2-token',
        'c2-jwt',
        '--customer3-token',
        'c3-jwt',
        '--quiet',
      ]);
      expect(args.baseUrl).toBe('http://api.dbs.internal:8080');
      expect(args.authMode).toBe('cloud');
      expect(args.operatorToken).toBe('op-jwt');
      expect(args.customer1Token).toBe('c1-jwt');
      expect(args.customer2Token).toBe('c2-jwt');
      expect(args.customer3Token).toBe('c3-jwt');
      expect(args.quiet).toBe(true);
    });

    it('TC-70-04c throws error on invalid arguments or missing values', () => {
      expect(() => parseCliArgs(['--url'])).toThrow(SeedError);
      expect(() => parseCliArgs(['--auth', 'unknown'])).toThrow(SeedError);
      expect(() => parseCliArgs(['--operator-token'])).toThrow(SeedError);
      expect(() => parseCliArgs(['--unknown-flag'])).toThrow(SeedError);
    });
  });

  describe('BL-252 cloud tokens from the environment', () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const key of TOKEN_ENV) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });
    afterEach(() => {
      for (const key of TOKEN_ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it('TC-252-04a reads the four tokens from DBS_*_TOKEN and maps customers in plan order', async () => {
      process.env.DBS_OPERATOR_TOKEN = 'env-op';
      process.env.DBS_CUSTOMER_1_TOKEN = 'env-c1';
      process.env.DBS_CUSTOMER_2_TOKEN = 'env-c2';
      process.env.DBS_CUSTOMER_3_TOKEN = 'env-c3';
      await expect(resolveTokens({ baseUrl: 'http://x', authMode: 'cloud' })).resolves.toEqual({
        operator: 'env-op',
        customers: {
          'demo-customer-minh-anh': 'env-c1',
          'demo-customer-thu-ha': 'env-c2',
          'demo-customer-van-binh': 'env-c3',
        },
      });
    });

    it('TC-252-04b the environment wins over the deprecated flags, which still work alone', async () => {
      const flags = {
        operatorToken: 'flag-op',
        customer1Token: 'flag-c1',
        customer2Token: 'flag-c2',
        customer3Token: 'flag-c3',
      };
      const only = await resolveTokens({ baseUrl: 'http://x', authMode: 'cloud' }, flags);
      expect(only.operator).toBe('flag-op');
      expect(only.customers['demo-customer-thu-ha']).toBe('flag-c2');
      process.env.DBS_OPERATOR_TOKEN = 'env-op';
      process.env.DBS_CUSTOMER_2_TOKEN = 'env-c2';
      const mixed = await resolveTokens({ baseUrl: 'http://x', authMode: 'cloud' }, flags);
      expect(mixed.operator).toBe('env-op');
      expect(mixed.customers['demo-customer-thu-ha']).toBe('env-c2');
      expect(mixed.customers['demo-customer-minh-anh']).toBe('flag-c1');
    });

    it('TC-252-04c a missing or empty token names the variables and never a value', async () => {
      process.env.DBS_OPERATOR_TOKEN = '';
      await expect(resolveTokens({ baseUrl: 'http://x', authMode: 'cloud' })).rejects.toThrow(
        /DBS_OPERATOR_TOKEN/,
      );
      process.env.DBS_OPERATOR_TOKEN = 'env-op';
      process.env.DBS_CUSTOMER_1_TOKEN = 'env-c1';
      await expect(resolveTokens({ baseUrl: 'http://x', authMode: 'cloud' })).rejects.toThrow(
        /DBS_CUSTOMER_1_TOKEN, DBS_CUSTOMER_2_TOKEN and DBS_CUSTOMER_3_TOKEN/,
      );
    });

    it('TC-252-04d the token flags warn on stderr by name only, the env path stays silent', async () => {
      const run = async (argv: string[]) => {
        let stderr = '';
        await runSeedCli([...argv, '--url', 'http://127.0.0.1:59999', '--auth', 'cloud'], {
          stdout: () => undefined,
          stderr: text => {
            stderr += text;
          },
        });
        return stderr;
      };
      const withFlags = await run([
        '--operator-token',
        'SECRET-OP-JWT',
        '--customer1-token',
        'SECRET-C1-JWT',
      ]);
      expect(withFlags).toContain('--operator-token, --customer1-token is deprecated');
      expect(withFlags).toContain('DBS_OPERATOR_TOKEN');
      expect(withFlags).not.toContain('SECRET');
      const withoutFlags = await run([]);
      expect(withoutFlags).not.toContain('Warning:');
    });

    it('TC-252-04e --help documents the env vars as the supported way and the flags as deprecated', async () => {
      let stdout = '';
      await runSeedCli(['--help'], {
        stdout: text => {
          stdout += text;
        },
        stderr: () => undefined,
      });
      expect(stdout).toMatch(/--operator-token <jwt>\s+DEPRECATED/);
      for (const key of TOKEN_ENV) expect(stdout).toContain(key);
      expect(stdout).toContain('demo-token.sh');
    });
  });

  describe('runSeedCli execution', () => {
    it('TC-70-04d prints help text and exits 0 when --help is passed', async () => {
      let stdout = '';
      let stderr = '';
      const code = await runSeedCli(['--help'], {
        stdout: text => {
          stdout += text;
        },
        stderr: text => {
          stderr += text;
        },
      });

      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('Digital Banking Simulator — Demo Data Seed Script (DBS-70)');
      expect(stdout).toContain('--url');
      expect(stdout).toContain('--auth');
    });

    it('TC-70-04e handles server connection errors gracefully and exits 1', async () => {
      let stdout = '';
      let stderr = '';
      const code = await runSeedCli(['--url', 'http://127.0.0.1:59999', '--auth', 'local'], {
        stdout: text => {
          stdout += text;
        },
        stderr: text => {
          stderr += text;
        },
      });

      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/Error:/);
    });
  });

  describe('BL-252 seed in the production image (seed-core, seed-cloud)', () => {
    const scripts = join(__dirname, '..', 'src', 'scripts');
    const source = (file: string): string => readFileSync(join(scripts, file), 'utf8');

    it('TC-252-05a seed-core and seed-cloud never import dev-auth, so the image carries no token signer', () => {
      for (const file of ['seed-core.ts', 'seed-cloud.ts']) {
        expect(source(file)).not.toMatch(/from\s+['"][^'"]*dev-auth/);
        expect(source(file)).not.toMatch(/require\(\s*['"][^'"]*dev-auth/);
      }
      expect(source('seed-cloud.ts')).toMatch(/from\s+'\.\/seed-core'/);
      expect(source('seed.ts')).toMatch(/from\s+'\.\/dev-auth'/);
    });

    it('TC-252-05b the production build leaves out seed.ts (dev-auth) but keeps seed-core and seed-cloud', () => {
      const build = JSON.parse(
        readFileSync(join(__dirname, '..', 'tsconfig.build.json'), 'utf8'),
      ) as { exclude: string[] };
      expect(build.exclude).toContain('src/scripts/dev-auth*.ts');
      expect(build.exclude.filter(e => e.includes('seed'))).toEqual(['src/scripts/seed.ts']);
    });

    it('TC-252-05c without mintLocalToken (the cloud build), --auth local fails with a clear message and signs nothing', async () => {
      await expect(coreResolveTokens({ baseUrl: 'http://x', authMode: 'local' })).rejects.toThrow(
        /Local auth \(--auth local\) is not available in this build/,
      );
      let stderr = '';
      const code = await coreRunSeedCli(['--url', 'http://127.0.0.1:59999', '--auth', 'local'], {
        stdout: () => undefined,
        stderr: text => {
          stderr += text;
        },
      });
      expect(code).toBe(1);
      expect(stderr).toMatch(/not available in this build/);
    });

    it('TC-252-05d the dev entry point injects the signer: seed.ts resolveTokens still mints local tokens', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'seed-keys-'));
      try {
        await generateDevKeys({ dir });
        const tokens = await resolveTokens({ baseUrl: 'http://x', authMode: 'local', keyDir: dir });
        expect(tokens.operator.split('.')).toHaveLength(3);
        expect(Object.keys(tokens.customers)).toHaveLength(3);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('formatReport', () => {
    it('TC-70-04f generates human-readable demo summary', () => {
      const mockReport: SeedReport = {
        baseUrl: 'http://127.0.0.1:3000',
        customers: [
          {
            sub: 'demo-customer-minh-anh',
            fullName: 'Nguyễn Minh Anh',
            customerId: '11111111-1111-4111-8111-111111111111',
            accounts: [
              {
                id: '22222222-2222-4222-8222-222222222222',
                type: 'CHECKING',
                status: 'ACTIVE',
                reused: false,
                finalBalance: '48000000',
              },
            ],
          },
        ],
        deposits: [
          {
            toAccountId: '22222222-2222-4222-8222-222222222222',
            amount: '50000000',
            transferId: '33333333-3333-4333-8333-333333333333',
            status: 'COMPLETED',
          },
        ],
        transfers: [
          {
            fromAccountId: '22222222-2222-4222-8222-222222222222',
            toAccountId: '44444444-4444-4444-8444-444444444444',
            amount: '2000000',
            transferId: '55555555-5555-4555-8555-555555555555',
            status: 'COMPLETED',
          },
        ],
      };

      const formatted = formatReport(mockReport);
      expect(formatted).toContain('Nguyễn Minh Anh');
      expect(formatted).toContain('48.000.000 VND');
      expect(formatted).toContain('CHECKING');
      expect(formatted).toContain('50.000.000 VND');
      expect(formatted).toContain('2.000.000 VND');
    });
  });
});
