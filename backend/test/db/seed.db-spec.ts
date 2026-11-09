import { OPERATOR_SUB, runSeed, SEED_CUSTOMERS, type SeedTokens } from '../../src/scripts/seed';
import { startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

const FUNDING_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

describe('DBS-70 seed.ts: demo data creation via HTTP API (PostgreSQL integration)', () => {
  let db: TempDatabase;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  let tokens: SeedTokens;

  const query = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

  const getAccountBalance = async (accountId: string): Promise<string> => {
    const rows = (await query('SELECT balance::text FROM accounts WHERE id = $1', [accountId])) as {
      balance: string;
    }[];
    return rows[0]?.balance ?? '0';
  };

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);

    const operatorToken = await app.issuer.token('operator', { sub: OPERATOR_SUB });
    const customers: Record<string, string> = {};
    for (const c of SEED_CUSTOMERS) {
      customers[c.sub] = await app.issuer.token('customer', { sub: c.sub });
    }
    tokens = { operator: operatorToken, customers };
  }, 60000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-70-01 runs seed first time: onboards customers, opens accounts, deposits, transfers (DoD #1)', async () => {
    const report = await runSeed({ baseUrl: app.url, tokens });

    expect(report.customers).toHaveLength(3);
    expect(report.deposits).toHaveLength(4);
    expect(report.transfers).toHaveLength(2);

    // Verify all accounts marked as created (not reused)
    const allAccounts = report.customers.flatMap(c => c.accounts);
    expect(allAccounts).toHaveLength(4);
    expect(allAccounts.every(a => !a.reused)).toBe(true);

    // Check balances
    const minhAnh = report.customers.find(c => c.sub === 'demo-customer-minh-anh')!;
    const minhAnhChecking = minhAnh.accounts.find(a => a.type === 'CHECKING')!;
    const minhAnhSavings = minhAnh.accounts.find(a => a.type === 'SAVINGS')!;
    const thuHa = report.customers.find(c => c.sub === 'demo-customer-thu-ha')!;
    const thuHaChecking = thuHa.accounts.find(a => a.type === 'CHECKING')!;
    const vanBinh = report.customers.find(c => c.sub === 'demo-customer-van-binh')!;
    const vanBinhChecking = vanBinh.accounts.find(a => a.type === 'CHECKING')!;

    expect(minhAnhChecking.finalBalance).toBe('48000000');
    expect(minhAnhSavings.finalBalance).toBe('20000000');
    expect(thuHaChecking.finalBalance).toBe('11500000');
    expect(vanBinhChecking.finalBalance).toBe('5500000');

    // Verify SYSTEM funding balance in DB
    const fundingBalance = await getAccountBalance(FUNDING_ACCOUNT_ID);
    expect(fundingBalance).toBe('-85000000');

    // Total non-system accounts in DB
    const accountsCount = (await query(
      "SELECT count(*)::int AS cnt FROM accounts WHERE type != 'SYSTEM'",
    )) as {
      cnt: number;
    }[];
    expect(accountsCount[0].cnt).toBe(4);
  });

  it('TC-70-02 re-runs seed second time: idempotent reuse without duplicates or errors (DoD #2)', async () => {
    const report2 = await runSeed({ baseUrl: app.url, tokens });

    expect(report2.customers).toHaveLength(3);
    expect(report2.deposits).toHaveLength(4);
    expect(report2.transfers).toHaveLength(2);

    // All accounts must be detected and reused
    const allAccounts = report2.customers.flatMap(c => c.accounts);
    expect(allAccounts).toHaveLength(4);
    expect(allAccounts.every(a => a.reused)).toBe(true);

    // DB total account count must still be 4
    const accountsCount = (await query(
      "SELECT count(*)::int AS cnt FROM accounts WHERE type != 'SYSTEM'",
    )) as {
      cnt: number;
    }[];
    expect(accountsCount[0].cnt).toBe(4);

    // Balances must remain exactly the same (no duplicate money deposited or transferred)
    const minhAnh = report2.customers.find(c => c.sub === 'demo-customer-minh-anh')!;
    const minhAnhChecking = minhAnh.accounts.find(a => a.type === 'CHECKING')!;
    const minhAnhSavings = minhAnh.accounts.find(a => a.type === 'SAVINGS')!;
    const thuHa = report2.customers.find(c => c.sub === 'demo-customer-thu-ha')!;
    const thuHaChecking = thuHa.accounts.find(a => a.type === 'CHECKING')!;
    const vanBinh = report2.customers.find(c => c.sub === 'demo-customer-van-binh')!;
    const vanBinhChecking = vanBinh.accounts.find(a => a.type === 'CHECKING')!;

    expect(minhAnhChecking.finalBalance).toBe('48000000');
    expect(minhAnhSavings.finalBalance).toBe('20000000');
    expect(thuHaChecking.finalBalance).toBe('11500000');
    expect(vanBinhChecking.finalBalance).toBe('5500000');

    const fundingBalance = await getAccountBalance(FUNDING_ACCOUNT_ID);
    expect(fundingBalance).toBe('-85000000');
  });

  it('TC-70-03 verifies all 5 ledger invariants PASS after seed (DoD #3)', async () => {
    const report = await checkLedgerInvariants(db.runner);
    expect(report.status).toBe('PASS');
    expect(report.violations).toHaveLength(0);
    expect(report.totals.balance).toBe('0');
    expect(BigInt(report.totals.debit)).toBe(BigInt(report.totals.credit));
  });
});
