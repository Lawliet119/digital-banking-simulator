// DBS-84 manual test: the daily limit on the real app, then EXPLAIN (ANALYZE, BUFFERS) of the
// daily-limit query on an account with one million debit lines. Real NestJS app, real JWT,
// PostgreSQL 17 in a Testcontainers container (UTC, like RDS).
const { runManual } = require('./lib/ledger-manual-harness.cjs');
const { SENT_TODAY_SQL } = require('../src/modules/ledger/sync-guard.service');
const { loadDailyDebitLedger } = require('../test/support/daily-debit-fixture');

// The query as it was before DBS-84: the day boundary came from clock_timestamp() inside the SQL.
const OLD_SQL = `SELECT coalesce(sum(amount),0)::text AS total FROM ledger_entries
  WHERE account_id=$1 AND direction='DEBIT'
    AND created_at >= date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')
                      AT TIME ZONE 'Asia/Ho_Chi_Minh'`;

runManual('DBS-84', async ctx => {
  const { q, db, transfer, target, balance, deposit, snapshot, invariant, assert, pass } = ctx;

  // M-84-01 / M-84-02: 4 x 50,000,000 pass, 1 dong more is refused
  const giang = await target('300000000'),
    hai = await target();
  for (let i = 0; i < 4; i++)
    assert.equal((await transfer(giang, hai.accountId, '50000000')).status, 201);
  pass('M-84-01', 'Vũ Thị Giang funded with 300,000,000 and sent 4 x 50,000,000 to Bùi Văn Hải');
  const before = await snapshot();
  const refused = await transfer(giang, hai.accountId, '1');
  assert.equal(refused.status, 422);
  assert.equal(refused.body.errorCode, 'LIMIT_PER_DAY_EXCEEDED');
  assert.equal((await snapshot()).lines, before.lines);
  assert.equal(await balance(hai.accountId), '200000000');
  pass('M-84-02', '1 dong more: 422 LIMIT_PER_DAY_EXCEEDED; Hải holds 200,000,000');

  // M-84-03: money received (deposit or transfer) never counts against the sender's limit
  assert.equal((await deposit(giang.accountId, '500000000')).status, 201);
  assert.equal((await transfer(hai, giang.accountId, '50000000')).status, 201);
  const again = await transfer(giang, hai.accountId, '1');
  assert.equal(again.body.errorCode, 'LIMIT_PER_DAY_EXCEEDED', 'Giang is still at the limit');
  await invariant();
  pass(
    'M-84-03',
    'Hải (received 200,000,000 today) sent 50,000,000; Giang received 500,000,000 + 50,000,000 yet is still at her sending limit',
  );

  // M-84-04 / M-84-05: one million debit lines of one account (SQL INPUT, disposable database)
  console.log('loading 1,000,000 debit lines of one account + 500,000 lines of 50,000 others ...');
  const loadStart = Date.now();
  await db.runner.startTransaction();
  const { hotAccountId } = await loadDailyDebitLedger(db.runner, {
    hotRows: 1_000_000,
    noiseRows: 500_000,
    noiseAccounts: 50_000,
    todayRows: 400,
    spanDays: 730,
  });
  await db.runner.commitTransaction();
  await q('VACUUM (ANALYZE) ledger_entries');
  const [{ n }] = await q(
    'SELECT count(*)::text AS n FROM ledger_entries WHERE account_id=$1 AND direction=$2',
    [hotAccountId, 'DEBIT'],
  );
  console.log(
    `loaded in ${((Date.now() - loadStart) / 1000).toFixed(1)} s; hot account: ${n} debit lines`,
  );
  assert.equal(n, '1000400');
  console.log(`SHOW timezone = ${(await q('SHOW timezone'))[0].TimeZone}`);

  const explain = async sql => {
    const rows = await q(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, [
      hotAccountId,
      new Date().toISOString(),
    ]);
    const text = rows.map(r => r['QUERY PLAN']).join('\n');
    return { text, ms: Number(/Execution Time: ([\d.]+) ms/.exec(text)[1]) };
  };
  // The old query takes one parameter; give it the same first one.
  const old = await q(`EXPLAIN (ANALYZE, BUFFERS) ${OLD_SQL}`, [hotAccountId]);
  const oldText = old.map(r => r['QUERY PLAN']).join('\n');

  const runs = [];
  for (let i = 0; i < 7; i++) runs.push(await explain(SENT_TODAY_SQL));
  console.log('---- EXPLAIN (ANALYZE, BUFFERS), last of 7 runs ----');
  console.log(runs[runs.length - 1].text);
  const times = runs.map(r => r.ms).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(`execution times (ms), sorted: ${times.join(', ')}; median ${median}`);
  const plan = runs[runs.length - 1].text;
  assert.match(plan, /Index Only Scan using ledger_entries_daily_debit_idx/);
  assert.match(plan, /Heap Fetches: 0/);
  assert.doesNotMatch(plan, /Seq Scan/);
  assert.ok(median <= 5, `median ${median} ms exceeds 5 ms`);
  pass(
    'M-84-04',
    `Index Only Scan on ledger_entries_daily_debit_idx, Heap Fetches 0, median ${median} ms (<= 5 ms) with ${n} lines`,
  );

  console.log('---- the same account, the query as it was before DBS-84 (clock_timestamp()) ----');
  console.log(oldText);
  assert.match(oldText, /Seq Scan/);
  pass('M-84-05', 'the old query is a Seq Scan on the same data (control)');
});
