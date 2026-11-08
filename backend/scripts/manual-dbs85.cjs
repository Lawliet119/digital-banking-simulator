// DBS-85 manual test: the daily limit resets at 00:00 Vietnam time while PostgreSQL runs on UTC.
// Real NestJS app, real JWT, PostgreSQL 17 in a Testcontainers container. The application clock is
// moved to fixed instants; earlier ledger lines are inserted at exact instants (SQL INPUT: the
// ledger is append-only, so a line in the past can be inserted, never moved there).
const { runManual } = require('./lib/ledger-manual-harness.cjs');
const { Clock } = require('../src/common/clock');
const { postBackdatedTransfer } = require('../test/support/backdated-transfer');

runManual('DBS-85', async ctx => {
  const { q, app, db, transfer, target, invariant, assert, pass } = ctx;
  const clock = app.app.get(Clock, { strict: false });
  const setClock = iso => {
    const instant = new Date(iso);
    clock.now = () => instant;
    console.log(`application clock = ${iso} (${instant.toISOString()})`);
  };

  // M-85-01 the database zone and the day boundary of two neighbouring instants
  const [{ TimeZone }] = await q('SHOW timezone');
  assert.match(TimeZone, /^(Etc\/)?UTC$/);
  const day = async iso =>
    (
      await q(
        `SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')
                 AT TIME ZONE 'Asia/Ho_Chi_Minh')::text AS start`,
        [iso],
      )
    )[0].start;
  const before = await day('2026-03-14T23:59:59+07:00'),
    after = await day('2026-03-15T00:00:00+07:00');
  console.log(`SHOW timezone = ${TimeZone}`);
  console.log(`day start of 2026-03-14T23:59:59+07:00 = ${before}`);
  console.log(`day start of 2026-03-15T00:00:00+07:00 = ${after}`);
  assert.equal(before, '2026-03-13 17:00:00+00');
  assert.equal(after, '2026-03-14 17:00:00+00');
  pass('M-85-01', 'DB on UTC; 23:59:59+07 and 00:00:00+07 give two day starts 24 hours apart');

  // M-85-02 / M-85-03 the limit is full until 23:59:59+07 and free again at 00:00:00+07
  const giang = await target('300000000'),
    hai = await target();
  await postBackdatedTransfer(db.runner, {
    from: giang.accountId,
    to: hai.accountId,
    amount: '200000000',
    at: '2026-03-14T23:59:59+07:00',
    actorId: giang.userId,
  });
  console.log('SQL INPUT: Giang sent 200,000,000 to Hải at 2026-03-14T23:59:59+07:00');
  setClock('2026-03-14T23:59:59+07:00');
  const full = await transfer(giang, hai.accountId, '1');
  assert.equal(full.status, 422);
  assert.equal(full.body.errorCode, 'LIMIT_PER_DAY_EXCEEDED');
  pass('M-85-02', 'at 23:59:59+07 the day is full: 422 LIMIT_PER_DAY_EXCEEDED');
  setClock('2026-03-15T00:00:00+07:00');
  const free = await transfer(giang, hai.accountId, '50000000');
  assert.equal(free.status, 201);
  assert.equal(free.body.status, 'COMPLETED');
  pass('M-85-03', 'one second later (00:00:00+07) the limit is free again: 201 COMPLETED');

  // M-85-04 00:00:00+07 itself belongs to the new day
  const khanh = await target('300000000'),
    lan = await target();
  await postBackdatedTransfer(db.runner, {
    from: khanh.accountId,
    to: lan.accountId,
    amount: '200000000',
    at: '2026-03-15T00:00:00+07:00',
    actorId: khanh.userId,
  });
  console.log('SQL INPUT: Khánh sent 200,000,000 to Lan at 2026-03-15T00:00:00+07:00');
  setClock('2026-03-15T00:00:00+07:00');
  const newDay = await transfer(khanh, lan.accountId, '1');
  assert.equal(newDay.status, 422);
  assert.equal(newDay.body.errorCode, 'LIMIT_PER_DAY_EXCEEDED');
  pass('M-85-04', 'a debit written at exactly 00:00:00+07 counts in the new day: 422');

  await invariant();
});
