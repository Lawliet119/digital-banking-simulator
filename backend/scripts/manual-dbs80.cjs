// DBS-80 manual test: cross transfers, deadlock retry and database timeouts on the real app.
const { runManual } = require('./lib/ledger-manual-harness.cjs');
const { AuditService } = require('@modules/audit');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

runManual(
  'DBS-80',
  async ctx => {
    const { app, q, transfer, target, snapshot, balance, invariant, assert, pass, randomUUID } =
      ctx;
    const transfers = async () =>
      (await q("SELECT count(*)::int AS n FROM transfers WHERE type='TRANSFER'"))[0].n;
    const fault = async (body, action) => {
      await q('DROP SEQUENCE IF EXISTS dbs80_attempts');
      await q('CREATE SEQUENCE dbs80_attempts');
      await q(
        `CREATE FUNCTION dbs80_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NULL; END $$`,
      );
      await q(
        'CREATE TRIGGER dbs80_fault BEFORE INSERT ON ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION dbs80_fault()',
      );
      try {
        await action();
      } finally {
        await q('DROP TRIGGER dbs80_fault ON ledger_entries');
        await q('DROP FUNCTION dbs80_fault()');
      }
    };
    const attempts = async () =>
      (
        await q(
          'SELECT CASE WHEN is_called THEN last_value ELSE 0 END::int AS n FROM dbs80_attempts',
        )
      )[0].n;
    const failFirst = n =>
      `IF nextval('dbs80_attempts') <= ${n} THEN RAISE EXCEPTION 'injected deadlock' USING ERRCODE = '40P01'; END IF;`;

    const cuong = await target('10000000'),
      dung = await target('10000000');

    // M-80-01 200 opposite transfers, 20 at a time
    const jobs = Array.from({ length: 200 }, (_, i) => () => {
      const [from, to] = i % 2 ? [cuong, dung] : [dung, cuong];
      return transfer(from, to.accountId, '1000', randomUUID(), true);
    });
    const results = new Array(jobs.length);
    let next = 0;
    const started = Date.now();
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        while (next < jobs.length) {
          const i = next++;
          results[i] = await jobs[i]();
        }
      }),
    );
    const statuses = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
    console.log(JSON.stringify({ statuses, elapsedMs: Date.now() - started }));
    assert.deepEqual(statuses, { 201: 200 });
    assert.equal(await balance(cuong.accountId), '10000000');
    assert.equal(await balance(dung.accountId), '10000000');
    assert.equal(await transfers(), 200);
    await invariant();
    pass('M-80-01', '100 C->D + 100 D->C, 20 at a time: 200 x 201, balances unchanged, no 500/503');

    // M-80-02 deadlock on the first two attempts
    const k2 = randomUUID();
    await fault(failFirst(2), async () => {
      const res = await transfer(cuong, dung.accountId, '50000', k2);
      assert.equal(res.status, 201);
      assert.equal(await attempts(), 3);
    });
    assert.equal(await transfers(), 201);
    assert.equal(
      (await q('SELECT count(*)::int AS n FROM idempotency_keys WHERE idem_key=$1', [k2]))[0].n,
      1,
    );
    await invariant();
    pass('M-80-02', '40P01 twice: callback ran 3 times, still exactly one transfer and one key');

    // M-80-03 deadlock on every attempt, then the same key
    const k3 = randomUUID();
    await fault(failFirst(1000), async () => {
      const res = await transfer(cuong, dung.accountId, '50000', k3);
      assert.equal(res.status, 503);
      assert.equal(res.body.errorCode, 'SERVICE_TEMPORARILY_UNAVAILABLE');
      assert.equal(res.retryAfter, '5');
      assert.equal(await attempts(), 4);
      assert.equal(
        (await q('SELECT count(*)::int AS n FROM idempotency_keys WHERE idem_key=$1', [k3]))[0].n,
        0,
      );
    });
    const retried = await transfer(cuong, dung.accountId, '50000', k3);
    assert.equal(retried.status, 201);
    assert.equal(await transfers(), 202);
    await invariant();
    pass('M-80-03', '40P01 always: 4 runs, 503 + Retry-After: 5, no key left; same key then 201');

    // M-80-04 lock timeout (1000 ms in this run)
    const k4 = randomUUID();
    const held = app.source.createQueryRunner();
    await held.connect();
    await held.startTransaction();
    try {
      await held.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [cuong.accountId]);
      const t0 = Date.now();
      const res = await transfer(cuong, dung.accountId, '50000', k4);
      const elapsed = Date.now() - t0;
      console.log(JSON.stringify({ lockWaitMs: elapsed }));
      assert.equal(res.status, 503);
      assert.ok(res.retryAfter);
      assert.ok(elapsed >= 900 && elapsed < 4000);
    } finally {
      await held.rollbackTransaction();
      await held.release();
    }
    assert.equal((await transfer(cuong, dung.accountId, '50000', k4)).status, 201);
    await invariant();
    pass(
      'M-80-04',
      'row lock held past lock_timeout: 503 + Retry-After after ~1s; same key then 201',
    );

    // M-80-05 idle in transaction (500 ms in this run): the server closes the session
    const k5 = randomUUID();
    const audit = app.app.get(AuditService, { strict: false });
    const original = audit.record.bind(audit);
    let paused = false;
    audit.record = async (...args) => {
      if (!paused) {
        paused = true;
        await sleep(1500);
      }
      return original(...args);
    };
    const before = await snapshot();
    const res = await transfer(cuong, dung.accountId, '50000', k5);
    audit.record = original;
    assert.equal(res.status, 503);
    assert.equal(res.body.errorCode, 'SERVICE_TEMPORARILY_UNAVAILABLE');
    assert.ok(res.retryAfter);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await transfer(cuong, dung.accountId, '50000', k5)).status, 201);
    await invariant();
    pass(
      'M-80-05',
      'session closed by idle_in_transaction timeout: 503 + Retry-After (was 500), no trace; same key then 201',
    );
  },
  { timeouts: { lockTimeoutMs: 1000, statementTimeoutMs: 5000, idleInTransactionTimeoutMs: 500 } },
);
