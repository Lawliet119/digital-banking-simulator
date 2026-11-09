import {
  formatReport,
  parseCliArgs,
  runSeedCli,
  SeedError,
  type SeedReport,
} from '../src/scripts/seed';

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
