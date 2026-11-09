// DBS-70 manual test: seed demo data via HTTP API, verify idempotency and invariants
process.env.NODE_ENV = 'test';
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
  startPostgresContainer,
  stopPostgresContainer,
} = require('../test/support/postgres.container');
const { createTempDatabase, migrate } = require('../test/support/temp-database');
const { startDepositApp } = require('../test/support/deposit-app');
const { checkLedgerInvariants } = require('../test/support/invariants');
const {
  OPERATOR_SUB,
  SEED_CUSTOMERS,
  runSeed,
  formatReport,
} = require('../src/scripts/seed');

const FUNDING_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

async function main() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  console.log(`DBS-70 manual smoke test starting at commit: ${commit}`);

  let db, app;
  try {
    process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);

    const operatorToken = await app.issuer.token('operator', { sub: OPERATOR_SUB });
    const customers = {};
    for (const c of SEED_CUSTOMERS) {
      customers[c.sub] = await app.issuer.token('customer', { sub: c.sub });
    }
    const tokens = { operator: operatorToken, customers };

    console.log('M-70-01: Running seed script (first time)...');
    const report1 = await runSeed({ baseUrl: app.url, tokens });
    console.log(formatReport(report1));

    assert.equal(report1.customers.length, 3, 'Should have created 3 customers');
    assert.equal(report1.deposits.length, 4, 'Should have executed 4 deposits');
    assert.equal(report1.transfers.length, 2, 'Should have executed 2 transfers');

    const accounts1 = report1.customers.flatMap(c => c.accounts);
    assert.equal(accounts1.length, 4, 'Should have created 4 customer accounts');
    assert.ok(accounts1.every(a => !a.reused), 'All accounts should be newly created on first run');

    const ma = report1.customers.find(c => c.sub === 'demo-customer-minh-anh');
    const th = report1.customers.find(c => c.sub === 'demo-customer-thu-ha');
    const vb = report1.customers.find(c => c.sub === 'demo-customer-van-binh');

    assert.equal(ma.accounts.find(a => a.type === 'CHECKING').finalBalance, '48000000');
    assert.equal(ma.accounts.find(a => a.type === 'SAVINGS').finalBalance, '20000000');
    assert.equal(th.accounts.find(a => a.type === 'CHECKING').finalBalance, '11500000');
    assert.equal(vb.accounts.find(a => a.type === 'CHECKING').finalBalance, '5500000');

    const fundingRows = await db.runner.query('SELECT balance::text FROM accounts WHERE id = $1', [
      FUNDING_ACCOUNT_ID,
    ]);
    assert.equal(fundingRows[0].balance, '-85000000', 'System funding balance must be -85,000,000');
    console.log('M-70-01 PASS: First seed run completed, accounts and balances match specification.\n');

    console.log('M-70-02: Re-running seed script (second time, idempotency test)...');
    const report2 = await runSeed({ baseUrl: app.url, tokens });
    console.log(formatReport(report2));

    assert.equal(report2.customers.length, 3);
    assert.equal(report2.deposits.length, 4);
    assert.equal(report2.transfers.length, 2);

    const accounts2 = report2.customers.flatMap(c => c.accounts);
    assert.equal(accounts2.length, 4);
    assert.ok(accounts2.every(a => a.reused), 'All accounts should be reused on second run');

    const ma2 = report2.customers.find(c => c.sub === 'demo-customer-minh-anh');
    const th2 = report2.customers.find(c => c.sub === 'demo-customer-thu-ha');
    const vb2 = report2.customers.find(c => c.sub === 'demo-customer-van-binh');

    assert.equal(ma2.accounts.find(a => a.type === 'CHECKING').finalBalance, '48000000');
    assert.equal(ma2.accounts.find(a => a.type === 'SAVINGS').finalBalance, '20000000');
    assert.equal(th2.accounts.find(a => a.type === 'CHECKING').finalBalance, '11500000');
    assert.equal(vb2.accounts.find(a => a.type === 'CHECKING').finalBalance, '5500000');

    const fundingRows2 = await db.runner.query('SELECT balance::text FROM accounts WHERE id = $1', [
      FUNDING_ACCOUNT_ID,
    ]);
    assert.equal(fundingRows2[0].balance, '-85000000', 'Funding balance remains -85,000,000');
    console.log('M-70-02 PASS: Second seed run idempotent, no duplicate funds created.\n');

    console.log('M-70-03: Running checkLedgerInvariants...');
    const invReport = await checkLedgerInvariants(db.runner);
    console.log(JSON.stringify(invReport, null, 2));
    assert.equal(invReport.status, 'PASS', 'Invariants check must PASS');
    assert.equal(invReport.violations.length, 0, 'Violations count must be 0');
    assert.equal(invReport.totals.balance, '0', 'Ledger system balance must be 0');
    assert.equal(invReport.totals.debit, invReport.totals.credit, 'Debit must equal credit');
    console.log('M-70-03 PASS: All 5 ledger invariants verified clean.\n');

    console.log('ALL MANUAL CHECKS PASSED (M-70-01, M-70-02, M-70-03).');
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await db?.drop();
      } finally {
        await stopPostgresContainer();
      }
    }
    console.log('Cleanup completed.');
  }
}

main().catch(err => {
  console.error('Manual test failed:', err);
  process.exitCode = 1;
});

