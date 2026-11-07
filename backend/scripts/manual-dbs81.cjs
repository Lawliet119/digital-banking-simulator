// DBS-81 manual test: the original request rolls back (or commits) while an identical request waits on its key.
const { runManual } = require('./lib/ledger-manual-harness.cjs');

const GATE = 8181;

runManual('DBS-81', async ctx => {
  const { app, q, target, balance, invariant, assert, pass, randomUUID, waitFor } = ctx;
  const n = async (sql, args = []) => (await q(sql, args))[0].n;
  const waiting = locktype =>
    `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity s ON s.pid=l.pid WHERE l.locktype='${locktype}' AND NOT l.granted AND s.datname=current_database()`;
  const post = (a, to, amount, key) =>
    fetch(app.url + '/v1/transfers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${a.token}`,
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ fromAccountId: a.accountId, toAccountId: to, amount }),
    }).then(async res => ({ status: res.status, body: await res.json() }));
  const installGate = async fail => {
    await q('DROP SEQUENCE IF EXISTS dbs81_calls');
    await q('CREATE SEQUENCE dbs81_calls');
    await q(`CREATE OR REPLACE FUNCTION dbs81_gate() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE call_no bigint; BEGIN
      IF NEW.action = 'transfer' THEN
        PERFORM pg_advisory_xact_lock(${GATE});
        call_no := nextval('dbs81_calls');
        IF call_no = 1 AND ${fail} THEN RAISE EXCEPTION 'dbs81 the original fails'; END IF;
      END IF;
      RETURN NEW; END $$`);
    await q('DROP TRIGGER IF EXISTS dbs81_gate ON audit_log');
    await q(
      'CREATE TRIGGER dbs81_gate BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs81_gate()',
    );
  };
  const removeGate = async () => {
    await q('DROP TRIGGER IF EXISTS dbs81_gate ON audit_log');
    await q('DROP FUNCTION IF EXISTS dbs81_gate()');
  };

  async function run(fail, withWaiter) {
    const em = await target('2000000'),
      phuong = await target(),
      key = randomUUID();
    await installGate(fail);
    const gate = app.source.createQueryRunner();
    await gate.connect();
    try {
      await gate.query('SELECT pg_advisory_lock($1)', [GATE]);
      const a = post(em, phuong.accountId, '700000', key);
      await waitFor(async () => (await n(waiting('advisory'))) > 0, 'A stopped at the gate');
      console.log('A holds key K and is stopped at the gate');
      let b;
      if (withWaiter) {
        b = post(em, phuong.accountId, '700000', key);
        await waitFor(async () => (await n(waiting('transactionid'))) > 0, 'B waiting on A');
        const locks = await q(
          `SELECT l.locktype,l.granted,l.pid::int AS pid,pg_blocking_pids(l.pid) AS blocked_by FROM pg_locks l JOIN pg_stat_activity s ON s.pid=l.pid WHERE NOT l.granted AND s.datname=current_database() ORDER BY l.locktype`,
        );
        console.log(JSON.stringify({ pgLocksWhileWaiting: locks }));
        assert.ok(locks.some(l => l.locktype === 'transactionid' && l.blocked_by.length === 1));
      }
      await gate.query('SELECT pg_advisory_unlock_all()');
      const first = await a;
      const second = b ? await b : undefined;
      console.log(JSON.stringify({ A: first, B: second }));
      return { em, phuong, key, first, second };
    } finally {
      await gate.query('SELECT pg_advisory_unlock_all()');
      await gate.release();
      await removeGate();
    }
  }
  const transfersOf = async em =>
    n('SELECT count(*)::int AS n FROM transfers WHERE from_account_id=$1', [em.accountId]);

  // M-81-01 A fails, B waits
  let r = await run(true, true);
  assert.equal(r.first.status, 500);
  assert.equal(r.second.status, 201);
  assert.equal(r.second.body.status, 'COMPLETED');
  assert.equal(await transfersOf(r.em), 1);
  assert.equal(await balance(r.em.accountId), '1300000');
  assert.equal(await balance(r.phuong.accountId), '700000');
  assert.equal(
    await n('SELECT count(*)::int AS n FROM ledger_entries WHERE transfer_id=$1', [
      r.second.body.transferId,
    ]),
    2,
  );
  const stored = await q(
    'SELECT transfer_id,response_code,response_body FROM idempotency_keys WHERE idem_key=$1',
    [r.key],
  );
  assert.deepEqual(stored, [
    { transfer_id: r.second.body.transferId, response_code: 201, response_body: r.second.body },
  ]);
  await invariant();
  pass(
    'M-81-01',
    'A 500 (rolled back), B 201 COMPLETED as a new request; Em 1300000 / Phuong 700000; key holds B only',
  );

  // M-81-02 A commits, B waits
  r = await run(false, true);
  assert.equal(r.first.status, 201);
  assert.equal(r.second.status, 201);
  assert.deepEqual(r.second.body, r.first.body);
  assert.equal(await transfersOf(r.em), 1);
  assert.equal(await balance(r.em.accountId), '1300000');
  await invariant();
  pass('M-81-02', "A 201, B 201 with A's transferId; debited once");

  // M-81-03 A fails, nobody waits, client resends K
  r = await run(true, false);
  assert.equal(r.first.status, 500);
  assert.equal(
    await n('SELECT count(*)::int AS n FROM idempotency_keys WHERE idem_key=$1', [r.key]),
    0,
  );
  const resend = await post(r.em, r.phuong.accountId, '700000', r.key);
  console.log(JSON.stringify({ resend }));
  assert.equal(resend.status, 201);
  assert.equal(await transfersOf(r.em), 1);
  assert.equal(await balance(r.em.accountId), '1300000');
  await invariant();
  pass('M-81-03', 'A 500, key gone; resend of K -> 201 as new, debited once');
});
