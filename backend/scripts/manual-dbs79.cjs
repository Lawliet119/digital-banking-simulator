// DBS-79 manual test: idempotent replay of POST /v1/transfers on the real app and PostgreSQL.
const { runManual } = require('./lib/ledger-manual-harness.cjs');

runManual('DBS-79', async ctx => {
  const { q, transfer, target, snapshot, balance, invariant, assert, pass, randomUUID } = ctx;
  const same = body => {
    const { correlationId: _c, ...rest } = body;
    return rest;
  };
  const an = await target('1000000'),
    binh = await target();

  // M-79-01 replay a completed transfer
  const k1 = randomUUID();
  const first = await transfer(an, binh.accountId, '300000', k1);
  assert.equal(first.status, 201);
  const afterFirst = await snapshot();
  const again1 = await transfer(an, binh.accountId, '300000', k1);
  const again2 = await transfer(an, binh.accountId, '300000', k1);
  for (const r of [again1, again2]) {
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, first.body);
  }
  assert.deepEqual(await snapshot(), afterFirst);
  assert.equal(await balance(an.accountId), '700000');
  assert.equal(await balance(binh.accountId), '300000');
  await invariant();
  pass('M-79-01', 'three identical 201 answers, one transfer, balances An 700000 / Binh 300000');

  // M-79-02 same key, another amount
  const reused = await transfer(an, binh.accountId, '400000', k1);
  assert.equal(reused.status, 422);
  assert.equal(reused.body.errorCode, 'IDEMPOTENCY_KEY_REUSED');
  assert.deepEqual(await snapshot(), afterFirst);
  pass('M-79-02', 'same key + other amount -> 422 IDEMPOTENCY_KEY_REUSED, nothing written');

  // M-79-03 ten parallel requests, one key
  const k2 = randomUUID();
  const before = await snapshot();
  const parallel = await Promise.all(
    Array.from({ length: 10 }, () => transfer(an, binh.accountId, '1000', k2, true)),
  );
  assert.deepEqual(
    parallel.map(r => r.status),
    Array(10).fill(201),
  );
  for (const r of parallel) assert.deepEqual(r.body, parallel[0].body);
  const after = await snapshot();
  assert.equal(after.transfers, before.transfers + 1);
  assert.equal(after.lines, before.lines + 2);
  assert.equal(after.keys, before.keys + 1);
  console.log(
    JSON.stringify({ parallelStatuses: parallel.map(r => r.status), body: parallel[0].body }),
  );
  await invariant();
  pass('M-79-03', '10 parallel requests -> 10 equal 201, +1 transfer, +2 ledger lines, +1 key');

  // M-79-04 a refusal is replayed too
  const k3 = randomUUID();
  const refused = await transfer(an, binh.accountId, '5000000', k3);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.errorCode, 'INSUFFICIENT_FUNDS');
  const refusedAgain = await transfer(an, binh.accountId, '5000000', k3);
  assert.equal(refusedAgain.status, 422);
  assert.deepEqual(same(refusedAgain.body), same(refused.body));
  assert.deepEqual(
    await q('SELECT status,reject_reason FROM transfers WHERE id=$1', [refused.body.transferId]),
    [{ status: 'REJECTED', reject_reason: 'INSUFFICIENT_FUNDS' }],
  );
  assert.deepEqual(
    await q('SELECT count(*)::int AS n FROM transfers WHERE reject_reason IS NOT NULL'),
    [{ n: 1 }],
  );
  await invariant();
  pass('M-79-04', 'refusal replayed with the same transferId; exactly one REJECTED row');

  // M-79-05 above 2^53
  const big = '9007199254740993',
    neighbour = '9007199254740992';
  const chi = await target(big),
    dung = await target();
  ctx.app.limits.transfer.perTx = ctx.app.limits.transfer.perDay = BigInt(big);
  const k4 = randomUUID();
  const bigFirst = await transfer(chi, dung.accountId, big, k4);
  assert.equal(bigFirst.status, 201);
  const bigAgain = await transfer(chi, dung.accountId, big, k4);
  assert.deepEqual(bigAgain.body, bigFirst.body);
  const bigReused = await transfer(chi, dung.accountId, neighbour, k4);
  assert.equal(bigReused.status, 422);
  assert.equal(bigReused.body.errorCode, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await balance(dung.accountId), big);
  const [event] = await q('SELECT payload FROM outbox_events WHERE aggregate_id=$1', [
    bigFirst.body.transferId,
  ]);
  assert.equal(event.payload.amount, big);
  assert.deepEqual(
    await q('SELECT amount::text FROM ledger_entries WHERE transfer_id=$1', [
      bigFirst.body.transferId,
    ]),
    [{ amount: big }, { amount: big }],
  );
  await invariant();
  pass('M-79-05', '9007199254740993 exact in API, DB, ledger lines and event; ...992 -> REUSED');
});
