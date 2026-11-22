// DBS-142 / BL-421 manual test: the reconciliation job also checks the daily debit counter
// (accounts.sent_today / sent_day) against the DEBIT lines. Real app, real PostgreSQL 17, real
// transfers through the API; the counter is damaged the way a real fault would (owner edit, trigger
// off) and the real ReconciliationService must say MISMATCH, name the check, and recover to OK.
//   BENCH_ROWS=1000000 node scripts/manual-dbs142.cjs   (default 100000 ledger lines)
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
process.chdir(resolve(__dirname, '..'));
const { DataSource } = require('typeorm');
const { runManual } = require('./lib/ledger-manual-harness.cjs');
const { SystemClock } = require('../src/common/clock');
const { TransactionService } = require('../src/database/transaction.service');
const { RECONCILIATION_CHECK_SQL, ReconciliationService } = require('../src/modules/ledger');
const { checkLedgerInvariants } = require('../test/support/invariants');

const FUNDING_ID = '00000000-0000-4000-8000-000000000001';
const BENCH_ROWS = Number(process.env.BENCH_ROWS ?? 100_000);
const LIMITS = {
  transfer: { perTx: 50_000_000n, perDay: 200_000_000n },
  idempotencyKeyRetentionDays: 7,
  rateLimit: { transfersPerMinute: 10, requestsPerIpPerMinute: 100 },
  reconciliationIntervalMs: 300_000,
};

/** The SQL of origin/main (before BL-421), read from git so the comparison needs no copy. */
function sqlBeforeBl421() {
  const text = execFileSync(
    'git',
    ['show', 'origin/main:./src/modules/ledger/reconciliation.service.ts'],
    { encoding: 'utf8' },
  );
  const start = text.indexOf('export const RECONCILIATION_CHECK_SQL = `');
  const from = text.indexOf('`', start) + 1;
  return text.slice(from, text.indexOf('`;', from));
}

runManual('DBS-142', async ctx => {
  const { q, db, app, transfer, target, invariant, assert, pass } = ctx;
  const tx = app.app.get(TransactionService);
  const service = new ReconciliationService(tx, new SystemClock(), LIMITS);
  // The real code path logs through this.logger; show the line the operator would see.
  const logged = [];
  service.logger.warn = (obj, msg) => {
    logged.push(obj);
    console.log(JSON.stringify({ log: 'warn', msg, ...obj }));
  };
  const counter = async id =>
    (
      await q(
        `SELECT sent_today::text AS "sentToday", to_char(sent_day,'YYYY-MM-DD') AS "sentDay" FROM accounts WHERE id=$1`,
        [id],
      )
    )[0];
  const run = async step => {
    const outcome = await service.reconcileOnce();
    console.log(JSON.stringify({ step, outcome }));
    return outcome;
  };

  // M-142-01: real transfers; the trigger keeps the counter; job OK; check:invariants PASS.
  const sender = await target('5000000');
  const recipient = await target('0');
  assert.equal((await transfer(sender, recipient.accountId, '1500000')).status, 201);
  assert.equal((await transfer(sender, recipient.accountId, '200000')).status, 201);
  const good = await counter(sender.accountId);
  assert.equal(good.sentToday, '1700000');
  const clean = await run('M-142-01');
  assert.equal(clean.status, 'OK');
  await invariant();
  pass(
    'M-142-01',
    `two API transfers (1,500,000 + 200,000): counter ${JSON.stringify(good)}, job OK, check:invariants PASS`,
  );

  // M-142-02: the counter UNDER-counts (owner reset): the daily limit could be passed unseen.
  await q('UPDATE accounts SET sent_today = 0, sent_day = NULL WHERE id = $1', [sender.accountId]);
  const under = await run('M-142-02');
  assert.equal(under.status, 'MISMATCH');
  assert.equal(under.mismatchedAccounts, 0);
  assert.deepEqual(logged.at(-1).failedChecks, ['daily_debit_counters']);
  const report = await checkLedgerInvariants(db.runner);
  assert.equal(report.status, 'FAIL');
  assert.deepEqual(
    report.violations.map(v => [v.check, v.accountId]),
    [['daily_debit_totals', sender.accountId]],
  );
  console.log(JSON.stringify({ step: 'M-142-02-check-invariants', violations: report.violations }));
  pass(
    'M-142-02',
    'counter reset to 0: job MISMATCH, log failedChecks=[daily_debit_counters], check:invariants names the account',
  );

  // M-142-03: repair from the ledger (owner), next run OK.
  await q('UPDATE accounts SET sent_today = $2::bigint, sent_day = $3::date WHERE id = $1', [
    sender.accountId,
    good.sentToday,
    good.sentDay,
  ]);
  assert.equal((await run('M-142-03')).status, 'OK');
  await invariant();
  pass('M-142-03', 'counter restored from the ledger: job OK, check:invariants PASS');

  // M-142-04: the trigger is off while a REAL API transfer posts: only the counter falls behind.
  await q('ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_daily_debit_counter');
  try {
    assert.equal((await transfer(sender, recipient.accountId, '100000')).status, 201);
  } finally {
    await q('ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_daily_debit_counter');
  }
  assert.equal((await counter(sender.accountId)).sentToday, '1700000'); // ledger says 1,800,000
  const offTrigger = await run('M-142-04');
  assert.equal(offTrigger.status, 'MISMATCH');
  assert.equal(offTrigger.totalBalance, '0'); // money itself is right: only the counter is wrong
  assert.deepEqual(logged.at(-1).failedChecks, ['daily_debit_counters']);
  await q('UPDATE accounts SET sent_today = 1800000 WHERE id = $1', [sender.accountId]);
  assert.equal((await run('M-142-04-after-repair')).status, 'OK');
  pass(
    'M-142-04',
    'trigger off during a real transfer: counter 1,700,000 vs ledger 1,800,000 -> MISMATCH only on the counter; repaired -> OK',
  );

  // M-142-05: a SYSTEM account carries no counter; editing one is not a mismatch.
  await q(`UPDATE accounts SET sent_today = 5, sent_day = current_date WHERE id = $1`, [
    FUNDING_ID,
  ]);
  assert.equal((await run('M-142-05')).status, 'OK');
  await q(`UPDATE accounts SET sent_today = 0, sent_day = NULL WHERE id = $1`, [FUNDING_ID]);
  pass('M-142-05', 'counter edited on the SYSTEM account: job OK (SYSTEM is excluded)');

  // M-142-06: the job as the least-privilege role dbs_worker (SELECT on accounts is enough).
  const rolesSql = readFileSync(resolve(__dirname, '../../infra/scripts/db-roles.sql'), 'utf8');
  await q(rolesSql);
  await q(`ALTER ROLE dbs_worker LOGIN PASSWORD 'manual-role-pass'`);
  const workerUrl = new URL(db.url);
  workerUrl.username = 'dbs_worker';
  workerUrl.password = 'manual-role-pass';
  const workerSource = await new DataSource({
    type: 'postgres',
    url: workerUrl.toString(),
  }).initialize();
  try {
    const workerTx = new TransactionService(workerSource, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    });
    const asWorker = new ReconciliationService(workerTx, new SystemClock(), LIMITS);
    const ok = await asWorker.reconcileOnce();
    assert.equal(ok.status, 'OK');
    await q('UPDATE accounts SET sent_today = sent_today + 1 WHERE id = $1', [sender.accountId]);
    asWorker.logger.warn = (obj, msg) =>
      console.log(JSON.stringify({ log: 'warn', role: 'dbs_worker', msg, ...obj }));
    const bad = await asWorker.reconcileOnce();
    assert.equal(bad.status, 'MISMATCH');
    await q('UPDATE accounts SET sent_today = sent_today - 1 WHERE id = $1', [sender.accountId]);
    assert.equal((await asWorker.reconcileOnce()).status, 'OK');
  } finally {
    await workerSource.destroy();
  }
  pass(
    'M-142-06',
    'run as dbs_worker: OK, then MISMATCH after a +1 edit of the counter, then OK again',
  );

  // M-142-07: cost. Many debit lines over 30 days; same data, SQL before and after BL-421.
  const transfers = Math.floor(BENCH_ROWS / 2);
  const total = BigInt(transfers) * 1000n;
  await q(
    `WITH funding_tx AS (
       INSERT INTO transfers(id,type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id)
       VALUES (gen_random_uuid(),'DEPOSIT',$1,$2,$4::bigint,'COMPLETED',$3,gen_random_uuid()) RETURNING id)
     INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after)
     SELECT id, v.a, v.d, $4::bigint, 0 FROM funding_tx CROSS JOIN LATERAL (VALUES ($1::uuid,'DEBIT'),($2::uuid,'CREDIT')) v(a,d)`,
    [FUNDING_ID, sender.accountId, sender.userId, total.toString()],
  );
  await q(
    `WITH t AS (
       INSERT INTO transfers(id,type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id,created_at)
       SELECT gen_random_uuid(),'TRANSFER',$1,$2,1000,'COMPLETED',$3,gen_random_uuid(),
              now() - ((g % 30) || ' days')::interval
       FROM generate_series(1,$4::int) g
       RETURNING id, created_at)
     INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after,created_at)
     SELECT t.id, v.a, v.d, 1000, 0, t.created_at
     FROM t CROSS JOIN LATERAL (VALUES ($1::uuid,'DEBIT'),($2::uuid,'CREDIT')) v(a,d)`,
    [sender.accountId, recipient.accountId, sender.userId, transfers],
  );
  await q('UPDATE accounts SET balance = balance - $2::bigint WHERE id = $1', [
    FUNDING_ID,
    total.toString(),
  ]);
  await q('UPDATE accounts SET balance = balance + $2::bigint WHERE id = $1', [
    recipient.accountId,
    total.toString(),
  ]);
  // sender: +total (deposit) and -total (the transfers) cancel; funding and recipient move by total
  await q('VACUUM (ANALYZE) accounts, transfers, ledger_entries');
  const [{ lines }] = await q('SELECT COUNT(*)::int AS lines FROM ledger_entries');
  const explain = async sql => {
    const rows = await q(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
    return Number(
      /Execution Time: ([\d.]+) ms/.exec(rows.map(r => r['QUERY PLAN']).join('\n'))?.[1],
    );
  };
  const before = [
    await explain(sqlBeforeBl421()),
    await explain(sqlBeforeBl421()),
    await explain(sqlBeforeBl421()),
  ];
  const after = [
    await explain(RECONCILIATION_CHECK_SQL),
    await explain(RECONCILIATION_CHECK_SQL),
    await explain(RECONCILIATION_CHECK_SQL),
  ];
  console.log(
    JSON.stringify({
      step: 'M-142-07',
      ledgerLines: lines,
      msBeforeBl421: before,
      msAfterBl421: after,
    }),
  );
  const big = await run('M-142-07-job');
  assert.equal(
    big.status,
    'OK',
    'the counter of the bench account is right after one INSERT of many lines',
  );
  pass(
    'M-142-07',
    `${lines} ledger lines: EXPLAIN ANALYZE ms before BL-421 ${before.join('/')}, after ${after.join('/')}; job OK`,
  );

  await invariant();
  pass('M-142-08', 'check:invariants PASS at the end');
});
