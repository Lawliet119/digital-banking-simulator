import {
  formatReport,
  parseCliArgs,
  resolveTokens,
  runSeedCli,
  SeedError,
  type SeedReport,
} from '../src/scripts/seed';

const TOKEN_ENV = [
  'DBS_OPERATOR_TOKEN',
  'DBS_CUSTOMER_1_TOKEN',
  'DBS_CUSTOMER_2_TOKEN',
  'DBS_CUSTOMER_3_TOKEN',
] as const;

describe('DBS-70 Demo Data Seed CLI (offline e2e)', () => {
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
