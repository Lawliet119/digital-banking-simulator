// DBS-82 manual test: the order of the refusals of POST /v1/transfers on the real app and PostgreSQL.
const { runManual } = require('./lib/ledger-manual-harness.cjs');

runManual('DBS-82', async ctx => {
  const { q, transfer, target, balance, snapshot, invariant, assert, pass, randomUUID } = ctx;
  const rejected = async (from, to, amount) => {
    const before = await snapshot();
    const res = await transfer(from, to, amount);
    assert.equal(res.status, 422);
    const [row] = await q('SELECT status,reject_reason FROM transfers WHERE id=$1', [
      res.body.transferId,
    ]);
    assert.equal(row.status, 'REJECTED');
    assert.equal(row.reject_reason, res.body.errorCode);
    const after = await snapshot();
    assert.equal(after.lines, before.lines, 'no ledger line for a refusal');
    assert.equal(after.transfers, before.transfers + 1);
    return res.body.errorCode;
  };

  const giang = await target('1000'),
    hai = await target();

  // M-82-01 over the per-transfer limit AND short of money: the limit is the reason
  assert.equal(await rejected(giang, hai.accountId, '60000000'), 'LIMIT_PER_TX_EXCEEDED');
  await invariant();
  pass(
    'M-82-01',
    '60,000,000 with a balance of 1,000: LIMIT_PER_TX_EXCEEDED (before DBS-82: INSUFFICIENT_FUNDS)',
  );

  // M-82-02 short of money inside the limits
  assert.equal(await rejected(giang, hai.accountId, '5000'), 'INSUFFICIENT_FUNDS');
  assert.equal(await balance(giang.accountId), '1000');
  pass('M-82-02', '5,000 with a balance of 1,000: INSUFFICIENT_FUNDS');

  // M-82-03 destination LOCKED wins over limit and funds
  const locked = await target('0', 'LOCKED');
  assert.equal(await rejected(giang, locked.accountId, '60000000'), 'ACCOUNT_NOT_ACTIVE');
  pass('M-82-03', 'LOCKED destination, 60,000,000, short of money: ACCOUNT_NOT_ACTIVE');

  // M-82-04 per-day limit: 4 x 50,000,000 pass, one dong more is refused
  const rich = await target('250000000'),
    sink = await target();
  for (let i = 0; i < 4; i++)
    assert.equal((await transfer(rich, sink.accountId, '50000000')).status, 201);
  assert.equal(await rejected(rich, sink.accountId, '1'), 'LIMIT_PER_DAY_EXCEEDED');
  assert.equal(await balance(sink.accountId), '200000000');
  await invariant();
  pass('M-82-04', 'after 200,000,000 sent today the next 1 dong: LIMIT_PER_DAY_EXCEEDED');

  // M-82-05 destination that does not exist, over the limit and short of money
  assert.equal(await rejected(giang, randomUUID(), '60000000'), 'ACCOUNT_NOT_ACTIVE');
  const [row] = await q(
    "SELECT to_account_id FROM transfers WHERE reject_reason='ACCOUNT_NOT_ACTIVE' ORDER BY created_at DESC LIMIT 1",
  );
  assert.equal(row.to_account_id, null);
  await invariant();
  pass('M-82-05', 'unknown destination: ACCOUNT_NOT_ACTIVE stored with to_account_id NULL');
});
