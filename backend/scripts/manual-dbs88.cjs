// DBS-88 manual test: an operator finds customer accounts (FR-ACC-04) on the real app, with a real
// JWT and PostgreSQL 17 in a Testcontainers container. The money enters through the deposit API;
// users, customers and accounts are SQL INPUT (names are set by SQL so the search has something
// to find).
const { createHash } = require('node:crypto');
const { runManual } = require('./lib/ledger-manual-harness.cjs');
const {
  buildSearchSql,
  parseSearchQuery,
} = require('../src/modules/accounts/operator-account-search.query');

runManual('DBS-88', async ctx => {
  const { q, app, db, target, deposit, operator, assert, pass, randomUUID } = ctx;
  const get = async (term, token) => {
    const res = await fetch(`${app.url}/v1/operator/accounts?q=${encodeURIComponent(term)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    console.log(JSON.stringify({ method: 'GET', q: term, status: res.status, body }));
    return { status: res.status, body };
  };
  const named = async (name, amount = '0', status = 'ACTIVE') => {
    const row = await target(amount, status);
    await q('UPDATE customers SET full_name=$2 WHERE id=$1', [row.customerId, name]);
    return row;
  };

  // M-88-01 three customers; Minh Anh has two accounts and 5,000,000 on one
  const minhAnh = await named('Nguyễn Minh Anh', '5000000');
  const second = randomUUID();
  await q("INSERT INTO accounts(id,customer_id,type,status) VALUES($1,$2,'SAVINGS','ACTIVE')", [
    second,
    minhAnh.customerId,
  ]);
  const ha = await named('Trần Thu Hà');
  const binh = await named('Nguyễn Văn Bình', '0', 'LOCKED');
  const found = await get('nguyễn', operator);
  assert.equal(found.status, 200);
  assert.deepEqual(
    found.body.items.map(i => i.id).sort(),
    [minhAnh.accountId, second, binh.accountId].sort(),
  );
  for (const item of found.body.items)
    assert.deepEqual(Object.keys(item).sort(), ['id', 'ownerName', 'status', 'type']);
  assert.ok(!JSON.stringify(found.body).includes('5000000'));
  assert.ok(!/balance/i.test(JSON.stringify(found.body)));
  pass(
    'M-88-01',
    'q=nguyễn: 3 accounts (one LOCKED, one SAVINGS), 4 fields each, no balance although Minh Anh holds 5,000,000',
  );

  // M-88-02 by account id
  const byId = await get(ha.accountId, operator);
  assert.deepEqual(byId.body.items, [
    { id: ha.accountId, type: 'CHECKING', status: 'ACTIVE', ownerName: 'Trần Thu Hà' },
  ]);
  pass('M-88-02', 'the account id of Trần Thu Hà finds exactly her account');

  // M-88-03 % is a plain character
  const percent = await get('%', operator);
  assert.deepEqual(percent.body, { items: [] });
  pass('M-88-03', 'q=% matches no name (not a wildcard)');

  // M-88-04 customer and auditor are refused
  for (const [role, token] of [
    ['customer', ha.token],
    ['auditor', await app.issuer.token('auditor', { sub: randomUUID() })],
  ]) {
    const res = await get('nguyễn', token);
    assert.equal(res.status, 403, role);
    assert.ok(!JSON.stringify(res.body).includes('ownerName'));
  }
  pass('M-88-04', 'customer and auditor get 403 and no data');

  // M-88-05 the audit log
  const rows = await q(
    "SELECT actor_role,outcome,target_type,target_id,metadata FROM audit_log WHERE action='operator.account.search' ORDER BY id",
  );
  console.log(JSON.stringify(rows));
  assert.deepEqual(
    rows.map(r => r.metadata.count),
    [3, 1, 0],
  );
  assert.deepEqual(
    rows.map(r => r.target_type),
    ['account_search', 'account', 'account_search'],
  );
  assert.equal(rows[1].target_id, ha.accountId);
  const fp = term => createHash('sha256').update(term.toLowerCase()).digest('hex').slice(0, 32);
  assert.equal(rows[0].target_id, fp('nguyễn'));
  assert.equal(rows[2].target_id, fp('%'));
  assert.ok(!/Nguyễn|nguyễn|Hà/.test(JSON.stringify(rows)));
  pass(
    'M-88-05',
    '3 audit rows (counts 3, 1, 0), the id of Hà, fingerprints for the names, no name stored; the two refused calls left no row',
  );

  // M-88-06 50,000 customers: the search is a scan of customers (no index on full_name, decided)
  console.log('loading 50,000 customers ...');
  await q(`INSERT INTO users(cognito_sub) SELECT 'bulk-' || g FROM generate_series(1,50000) g`);
  await q(
    `INSERT INTO customers(user_id,full_name)
     SELECT id, (ARRAY['Nguyễn','Trần','Lê','Phạm','Hoàng','Phan','Vũ','Đặng','Bùi','Đỗ'])[1 + (row_number() OVER ())::int % 10]
            || ' Văn ' || substr(cognito_sub, 6)
     FROM users WHERE cognito_sub LIKE 'bulk-%'`,
  );
  await q(
    `INSERT INTO accounts(customer_id,type,status) SELECT id,'CHECKING','ACTIVE' FROM customers WHERE full_name LIKE '% Văn %'`,
  );
  await q('VACUUM (ANALYZE) customers');
  await q('VACUUM (ANALYZE) accounts');
  const { sql, parameters } = buildSearchSql(parseSearchQuery({ q: 'Nguyễn' }));
  const explain = async () => {
    const out = await q(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, parameters);
    const text = out.map(r => r['QUERY PLAN']).join('\n');
    return { text, ms: Number(/Execution Time: ([\d.]+) ms/.exec(text)[1]) };
  };
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await explain());
  console.log('---- EXPLAIN (ANALYZE, BUFFERS) of q=Nguyễn on 50,000 customers, last of 5 ----');
  console.log(runs[runs.length - 1].text);
  const [{ n }] = await q('SELECT count(*)::int AS n FROM customers');
  const res = await get('Nguyễn', operator);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 20);
  assert.match(runs[runs.length - 1].text, /Seq Scan on customers/);
  const times = runs.map(r => r.ms).sort((a, b) => a - b);
  pass(
    'M-88-06',
    `${n} customers: 20 results; the plan is a Seq Scan on customers (no index, as decided), execution ${times.join(', ')} ms`,
  );
});
