// DBS-87 manual test: transaction history (UC-6) and transfer status (UC-7) on the real app, then
// EXPLAIN (ANALYZE, BUFFERS) of page one on an account with one million ledger lines. Real NestJS
// app, real JWT, PostgreSQL 17 in a Testcontainers container.
const { runManual } = require('./lib/ledger-manual-harness.cjs');
const {
  buildHistorySql,
  parseHistoryQuery,
} = require('../src/modules/ledger/transaction-history.query');
const { loadDailyDebitLedger } = require('../test/support/daily-debit-fixture');

runManual('DBS-87', async ctx => {
  const { q, db, app, transfer, target, deposit, invariant, assert, pass, randomUUID } = ctx;
  const get = async (path, token) => {
    const res = await fetch(app.url + path, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    console.log(JSON.stringify({ method: 'GET', path, status: res.status, body }));
    return { status: res.status, body };
  };

  // M-87-01 Giang is funded and sends three transfers to Hải
  const giang = await target('1000000'),
    hai = await target(),
    khanh = await target();
  const sent = [];
  for (const amount of ['100000', '200000', '300000']) {
    const res = await transfer(giang, hai.accountId, amount);
    assert.equal(res.status, 201);
    sent.push(res.body.transferId);
  }
  pass('M-87-01', 'Giang funded with 1,000,000 and sent 100,000, 200,000 and 300,000 to Hải');

  // M-87-02 two pages of two lines
  const base = `/v1/accounts/${giang.accountId}/transactions`;
  const one = await get(`${base}?limit=2`, giang.token);
  assert.equal(one.status, 200);
  assert.deepEqual(
    one.body.items.map(i => [i.direction, i.amount]),
    [
      ['DEBIT', '300000'],
      ['DEBIT', '200000'],
    ],
  );
  assert.ok(one.body.nextCursor);
  const two = await get(`${base}?limit=2&cursor=${one.body.nextCursor}`, giang.token);
  assert.deepEqual(
    two.body.items.map(i => [i.type, i.direction, i.amount, i.counterpartyAccountId]),
    [
      ['TRANSFER', 'DEBIT', '100000', hai.accountId],
      ['DEPOSIT', 'CREDIT', '1000000', null],
    ],
  );
  assert.equal(two.body.nextCursor, null);
  pass(
    'M-87-02',
    'page 1: 300,000 and 200,000 DEBIT; page 2: 100,000 DEBIT and the 1,000,000 deposit (counterparty null); no cursor on the last page',
  );

  // M-87-03 someone else's account is a 404 identical to a missing one
  const foreign = await get(base, hai.token);
  const missing = await get(`/v1/accounts/${randomUUID()}/transactions`, hai.token);
  assert.equal(foreign.status, 404);
  assert.deepEqual(
    { ...foreign.body, correlationId: null },
    { ...missing.body, correlationId: null },
  );
  const denied = await q(
    "SELECT outcome,metadata FROM audit_log WHERE action='account.transactions' AND outcome='DENIED'",
  );
  assert.equal(denied.length, 2);
  pass(
    'M-87-03',
    'Hải reading Giang’s history: 404, same body as a missing account; two DENIED audit rows',
  );

  // M-87-04 sender and recipient read the transfer, a third party gets 404
  const bySender = await get(`/v1/transfers/${sent[0]}`, giang.token);
  const byRecipient = await get(`/v1/transfers/${sent[0]}`, hai.token);
  const byOther = await get(`/v1/transfers/${sent[0]}`, khanh.token);
  assert.equal(bySender.status, 200);
  assert.deepEqual(bySender.body, byRecipient.body);
  assert.equal(bySender.body.status, 'COMPLETED');
  assert.equal(byOther.status, 404);
  pass('M-87-04', 'Giang and Hải read COMPLETED 100,000; Khánh gets 404');

  // M-87-05 refused transfers: the sender sees a reason and no destination
  const short = await transfer(giang, hai.accountId, '5000000');
  const gone = await transfer(giang, randomUUID(), '1000');
  assert.equal(short.status, 422);
  assert.equal(gone.status, 422);
  const shortView = await get(`/v1/transfers/${short.body.transferId}`, giang.token);
  const goneView = await get(`/v1/transfers/${gone.body.transferId}`, giang.token);
  for (const view of [shortView, goneView]) {
    assert.equal(view.status, 200);
    assert.equal(view.body.status, 'REJECTED');
    assert.equal(view.body.toAccountId, undefined);
  }
  assert.equal(shortView.body.rejectReason, 'INSUFFICIENT_FUNDS');
  assert.equal(goneView.body.rejectReason, 'ACCOUNT_NOT_ACTIVE');
  assert.equal((await get(`/v1/transfers/${short.body.transferId}`, hai.token)).status, 404);
  await invariant();
  pass(
    'M-87-05',
    'REJECTED 5,000,000 (INSUFFICIENT_FUNDS) and to an unknown account (ACCOUNT_NOT_ACTIVE): no destination id; Hải cannot read the first',
  );

  // M-87-06 one million ledger lines of one account (SQL INPUT, disposable database)
  console.log('loading 1,000,000 ledger lines of one account + 500,000 lines of 50,000 others ...');
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
  await q('VACUUM (ANALYZE) transfers');
  console.log(`loaded in ${((Date.now() - loadStart) / 1000).toFixed(1)} s`);
  const { sql, parameters } = buildHistorySql(hotAccountId, parseHistoryQuery({ limit: '20' }));
  const explain = async () => {
    const rows = await q(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, parameters);
    const text = rows.map(r => r['QUERY PLAN']).join('\n');
    return { text, ms: Number(/Execution Time: ([\d.]+) ms/.exec(text)[1]) };
  };
  const runs = [];
  for (let i = 0; i < 7; i++) runs.push(await explain());
  console.log('---- EXPLAIN (ANALYZE, BUFFERS) of page one, last of 7 runs ----');
  console.log(runs[runs.length - 1].text);
  const times = runs.map(r => r.ms).sort((a, b) => a - b);
  const median = times[3];
  console.log(`execution times (ms), sorted: ${times.join(', ')}; median ${median}`);
  const plan = runs[runs.length - 1].text;
  assert.match(plan, /Index Scan using ledger_entries_account_history_idx/);
  assert.doesNotMatch(plan, /Sort|Seq Scan/);
  assert.ok(median <= 20, `median ${median} ms exceeds 20 ms`);
  // The same page through the real endpoint (JWT, ownership, audit, JSON): wall time per request.
  const hotToken = await app.issuer.token('customer', { sub: 'nguyen-minh-local' });
  const timings = [];
  for (let i = 0; i < 7; i++) {
    const start = process.hrtime.bigint();
    const res = await fetch(`${app.url}/v1/accounts/${hotAccountId}/transactions?limit=20`, {
      headers: { Authorization: `Bearer ${hotToken}` },
    });
    const body = await res.json();
    timings.push(Number(process.hrtime.bigint() - start) / 1e6);
    assert.equal(res.status, 200);
    assert.equal(body.items.length, 20);
    assert.ok(body.nextCursor);
  }
  timings.sort((a, b) => a - b);
  console.log(
    `HTTP page one of the million-line account (ms), sorted: ${timings.map(t => t.toFixed(1)).join(', ')}`,
  );
  pass(
    'M-87-06',
    `Index Scan using ledger_entries_account_history_idx, no Sort, median ${median} ms (<= 20 ms); HTTP page one median ${timings[3].toFixed(1)} ms`,
  );
});
