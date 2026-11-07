// DBS-83 manual test: refused transfers are stored, committed before the 422, and hide the destination.
const { runManual } = require('./lib/ledger-manual-harness.cjs');

const FUNDING = '00000000-0000-4000-8000-000000000001';

runManual('DBS-83', async ctx => {
  const { q, transfer, target, snapshot, balance, invariant, assert, pass, randomUUID } = ctx;
  const publicPart = body => {
    const { transferId: _t, correlationId: _c, ...rest } = body;
    return rest;
  };

  const khoa = await target('1000000'),
    locked = await target('0', 'LOCKED');

  // M-83-01 three destinations, one answer
  const unknown = randomUUID();
  const bodies = [];
  const stored = [];
  for (const to of [unknown, FUNDING, locked.accountId]) {
    const res = await transfer(khoa, to, '60000000');
    assert.equal(res.status, 422);
    assert.ok(res.contentType.includes('application/problem+json'));
    bodies.push(publicPart(res.body));
    const [row] = await q('SELECT status,reject_reason,to_account_id FROM transfers WHERE id=$1', [
      res.body.transferId,
    ]);
    stored.push(row.to_account_id);
    assert.equal(row.status, 'REJECTED');
  }
  assert.deepEqual(bodies[1], bodies[0]);
  assert.deepEqual(bodies[2], bodies[0]);
  assert.equal(bodies[0].errorCode, 'ACCOUNT_NOT_ACTIVE');
  assert.deepEqual(stored, [null, null, locked.accountId]);
  console.log(JSON.stringify({ sameAnswerForAll: bodies[0], storedToAccountId: stored }));
  await invariant();
  pass(
    'M-83-01',
    'unknown / funding / LOCKED destination: identical 422; to_account_id NULL, NULL, id',
  );

  // M-83-02 replay of the refusal to the unknown destination
  const key = randomUUID();
  const first = await transfer(khoa, unknown, '500', key);
  const before = await snapshot();
  const again = await transfer(khoa, unknown, '500', key);
  assert.equal(again.status, 422);
  assert.equal(again.body.transferId, first.body.transferId);
  assert.deepEqual(publicPart(again.body), publicPart(first.body));
  assert.deepEqual(await snapshot(), before);
  pass('M-83-02', 'same key again: same 422, same transferId, no new rows');

  // M-83-03 every RejectReason leaves transfer + audit + key and moves no money
  const rich = await target('250000000'),
    sink = await target(),
    poor = await target('100000');
  for (let i = 0; i < 4; i++)
    assert.equal((await transfer(rich, sink.accountId, '50000000')).status, 201);
  const cases = [
    ['ACCOUNT_NOT_ACTIVE', khoa, locked.accountId, '300000'],
    ['LIMIT_PER_TX_EXCEEDED', rich, sink.accountId, '50000001'],
    ['LIMIT_PER_DAY_EXCEEDED', rich, sink.accountId, '1'],
    ['INSUFFICIENT_FUNDS', poor, sink.accountId, '300000'],
  ];
  for (const [reason, from, to, amount] of cases) {
    const b = await snapshot();
    const res = await transfer(from, to, amount);
    assert.equal(res.status, 422);
    assert.equal(res.body.errorCode, reason);
    const a = await snapshot();
    assert.equal(a.transfers, b.transfers + 1);
    assert.equal(a.audits, b.audits + 1);
    assert.equal(a.keys, b.keys + 1);
    assert.equal(a.lines, b.lines);
    assert.equal(a.events, b.events);
    assert.deepEqual(a.balances, b.balances);
    const [t] = await q('SELECT status,reject_reason FROM transfers WHERE id=$1', [
      res.body.transferId,
    ]);
    assert.deepEqual(t, { status: 'REJECTED', reject_reason: reason });
    const [audit] = await q('SELECT outcome FROM audit_log WHERE target_id=$1', [
      res.body.transferId,
    ]);
    assert.equal(audit.outcome, 'REJECTED');
    console.log(JSON.stringify({ reason, transferId: res.body.transferId, stored: t }));
  }
  await invariant();
  pass(
    'M-83-03',
    'LOCKED / over per-transfer / over per-day / short of money: 1 REJECTED + 1 audit + 1 key each, no ledger line, balances unchanged',
  );

  // M-83-04 a failing audit write leaves nothing; after recovery the refusal is stored once
  const k4 = randomUUID();
  const b4 = await snapshot();
  await q(
    `CREATE FUNCTION dbs83_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$`,
  );
  await q(
    'CREATE TRIGGER dbs83_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs83_fail()',
  );
  try {
    const down = await transfer(poor, sink.accountId, '300000', k4);
    assert.equal(down.status, 500);
    assert.deepEqual(await snapshot(), b4);
  } finally {
    await q('DROP TRIGGER dbs83_fail ON audit_log');
    await q('DROP FUNCTION dbs83_fail()');
  }
  const ok = await transfer(poor, sink.accountId, '300000', k4);
  assert.equal(ok.status, 422);
  assert.equal(ok.body.errorCode, 'INSUFFICIENT_FUNDS');
  const a4 = await snapshot();
  assert.equal(a4.transfers, b4.transfers + 1);
  assert.equal(a4.keys, b4.keys + 1);
  assert.equal(await balance(poor.accountId), '100000');
  await invariant();
  pass(
    'M-83-04',
    'audit down: 500 and nothing stored; after recovery the same key gets the stored 422 once',
  );
});
