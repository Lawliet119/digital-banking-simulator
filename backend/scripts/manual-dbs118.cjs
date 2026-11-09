// DBS-118 manual test: intentional mismatch detection and concurrent transfers (AC-5.9 / DBS-99).
const { resolve } = require('node:path');
process.chdir(resolve(__dirname, '..'));
const { runManual } = require('./lib/ledger-manual-harness.cjs');
const { SystemClock } = require('../src/common/clock');
const { TransactionService } = require('../src/database/transaction.service');
const { ReconciliationService } = require('../src/modules/ledger');

/** Runs the tasks with at most `limit` in flight, keeping the order of the results. */
async function limited(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]();
      }
    }),
  );
  return results;
}

runManual('DBS-118', async ctx => {
  const { q, app, transfer, target, deposit, invariant, assert, pass } = ctx;

  const tx = app.app.get(TransactionService);
  const service = new ReconciliationService(tx, new SystemClock(), {
    transfer: { perTx: 50_000_000n, perDay: 200_000_000n },
    idempotencyKeyRetentionDays: 7,
    rateLimit: { transfersPerMinute: 10, requestsPerIpPerMinute: 100 },
    reconciliationIntervalMs: 300_000,
  });

  // M-118-01: Clean ledger after operator deposit (5,000,000) and transfer (1,500,000) -> status = OK
  const minhAnh = await target('5000000');
  const thuHa = await target('0');
  await q('UPDATE public.customers SET full_name = $2 WHERE id = $1', [
    thuHa.customerId,
    'Trần Thu Hà',
  ]);
  const transferRes = await transfer(minhAnh, thuHa.accountId, '1500000');
  assert.equal(transferRes.status, 201);

  const run1 = await service.reconcileOnce();
  console.log(JSON.stringify({ step: 'M-118-01', run1 }));
  assert.equal(run1.executed, true);
  assert.equal(run1.status, 'OK');
  assert.equal(run1.totalDebit, '6500000');
  assert.equal(run1.totalCredit, '6500000');
  assert.equal(run1.totalBalance, '0');
  assert.equal(run1.mismatchedAccounts, 0);
  assert.deepEqual(run1.details, []);
  pass(
    'M-118-01',
    'Minh Anh funded 5,000,000 and transferred 1,500,000 to Trần Thu Hà; reconcileOnce() returned status = OK (totalDebit = totalCredit = 6,500,000, totalBalance = 0)',
  );

  // M-118-02: Corrupt Minh Anh balance (+100,000) using table-owner role -> MISMATCH, then restore -> OK
  await q('UPDATE public.accounts SET balance = 3600000 WHERE id = $1', [minhAnh.accountId]);
  const run2Mismatch = await service.reconcileOnce();
  console.log(JSON.stringify({ step: 'M-118-02-mismatch', run2Mismatch }));
  assert.equal(run2Mismatch.executed, true);
  assert.equal(run2Mismatch.status, 'MISMATCH');
  assert.equal(run2Mismatch.totalBalance, '100000');
  assert.equal(run2Mismatch.mismatchedAccounts, 1);
  assert.deepEqual(run2Mismatch.details, [
    {
      accountId: minhAnh.accountId,
      balance: '3600000',
      ledgerBalance: '3500000',
    },
  ]);
  // Verify zero PII in details
  const detail = run2Mismatch.details[0];
  assert.equal('name' in detail, false);
  assert.equal('email' in detail, false);

  // Restore balance
  await q('UPDATE public.accounts SET balance = 3500000 WHERE id = $1', [minhAnh.accountId]);
  const run2Recovered = await service.reconcileOnce();
  console.log(JSON.stringify({ step: 'M-118-02-recovered', run2Recovered }));
  assert.equal(run2Recovered.status, 'OK');
  assert.equal(run2Recovered.totalBalance, '0');
  assert.equal(run2Recovered.mismatchedAccounts, 0);
  assert.deepEqual(run2Recovered.details, []);
  pass(
    'M-118-02',
    'Corrupted Minh Anh balance (3,600,000 vs ledger 3,500,000) detected as MISMATCH with exact details and zero PII; restored to OK',
  );

  // M-118-03: On the same DB, create 3 more customers and run 50 concurrent cross transfers -> reconcileOnce() OK
  const cust3 = await target('10000000');
  const cust4 = await target('10000000');
  const cust5 = await target('10000000');

  // Fund minhAnh and thuHa additional funds for the concurrent transfers
  const depA = await deposit(minhAnh.accountId, '10000000');
  assert.equal(depA.status, 201);
  const depB = await deposit(thuHa.accountId, '5000000');
  assert.equal(depB.status, 201);

  // thuHa acts as the HOT account
  const hotAccount = thuHa;
  const senders = [minhAnh, cust3, cust4, cust5];

  const tasks = [];
  for (let i = 0; i < 50; i++) {
    const sender = senders[i % senders.length];
    const targetAccId = i < 30 ? hotAccount.accountId : senders[(i + 1) % senders.length].accountId;
    const amount = `${10000 + (i % 5) * 5000}`;
    tasks.push(async () => {
      const res = await transfer(sender, targetAccId, amount, undefined, true);
      return res.status;
    });
  }

  const statuses = await limited(tasks, 10);
  const successCount = statuses.filter(s => s === 201).length;
  assert.equal(successCount, 50);

  const run3 = await service.reconcileOnce();
  console.log(JSON.stringify({ step: 'M-118-03-concurrent', run3 }));
  assert.equal(run3.executed, true);
  assert.equal(run3.status, 'OK');
  assert.equal(run3.totalDebit, run3.totalCredit);
  assert.equal(run3.totalBalance, '0');
  assert.equal(run3.mismatchedAccounts, 0);
  assert.deepEqual(run3.details, []);

  await invariant();
  pass(
    'M-118-03',
    'Executed 50 concurrent transfers with hot recipient on the same DB; reconcileOnce() returned status = OK and checkLedgerInvariants returned PASS',
  );

  // M-118-04: Corrupt hot account balance (-50,000) after concurrent load -> MISMATCH, then restore -> OK
  await q('UPDATE public.accounts SET balance = balance - 50000 WHERE id = $1', [hotAccount.accountId]);
  const run4Mismatch = await service.reconcileOnce();
  console.log(JSON.stringify({ step: 'M-118-04-mismatch', run4Mismatch }));
  assert.equal(run4Mismatch.executed, true);
  assert.equal(run4Mismatch.status, 'MISMATCH');
  assert.equal(run4Mismatch.totalBalance, '-50000');
  assert.equal(run4Mismatch.mismatchedAccounts, 1);
  assert.equal(run4Mismatch.details[0].accountId, hotAccount.accountId);
  assert.equal(
    BigInt(run4Mismatch.details[0].ledgerBalance) - BigInt(run4Mismatch.details[0].balance),
    50000n,
  );

  // Restore hot account
  await q('UPDATE public.accounts SET balance = balance + 50000 WHERE id = $1', [hotAccount.accountId]);
  const run4Recovered = await service.reconcileOnce();
  console.log(JSON.stringify({ step: 'M-118-04-recovered', run4Recovered }));
  assert.equal(run4Recovered.status, 'OK');
  assert.equal(run4Recovered.totalBalance, '0');
  assert.equal(run4Recovered.mismatchedAccounts, 0);
  assert.deepEqual(run4Recovered.details, []);

  await invariant();
  pass(
    'M-118-04',
    'Corrupted hot account balance (-50,000) detected as MISMATCH; restored to OK; checkLedgerInvariants PASS; cleanup complete',
  );
});
