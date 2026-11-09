// Real HTTP/JWT/PostgreSQL driver, independent of Jest. Tokens and credentials are never printed.
const path = require('node:path');
process.env.TS_NODE_PROJECT ??= path.resolve(__dirname, '../tsconfig.json');
process.chdir(path.resolve(__dirname, '..'));
const { runManual } = require('./lib/ledger-manual-harness.cjs');

runManual('DBS-115', async ctx => {
  const { app, q, target, http, deposit, invariant, operator, assert, pass } = ctx;
  const user = await target(); // Harness labels this SQL INPUT at migration default zero.
  const get = async (urlPath, token) => {
    const response = await fetch(app.url + urlPath, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await response.json();
    const result = {
      status: response.status,
      correlationId: response.headers.get('x-correlation-id'),
      body,
    };
    console.log(JSON.stringify({ method: 'GET', path: urlPath, ...result }));
    return result;
  };
  const token = iat =>
    app.issuer.token('customer', {
      sub: user.sub,
      iat,
      exp: Math.floor(Date.now() / 1000) + 900,
    });
  const revoked = result => {
    assert.equal(result.status, 401);
    assert.equal(result.body.errorCode, 'SESSION_REVOKED');
    assert.ok(result.correlationId);
    assert.equal(result.body.correlationId, result.correlationId);
  };
  const opened = await http('/v1/accounts', { type: 'SAVINGS' }, user.token, null);
  assert.equal(opened.status, 201);
  const activeId = opened.body.id;
  assert.equal((await deposit(activeId, '1000000')).status, 201);
  const before = await get(`/v1/accounts/${activeId}`, user.token);
  assert.equal(before.status, 200);
  assert.equal(before.body.status, 'ACTIVE');
  assert.equal(before.body.balance, '1000000');
  await invariant();
  pass(
    'M-115-01',
    `Same owner has A=${user.accountId}, B=${activeId}; B ACTIVE funded1000000 via HTTP, GET200`,
  );

  const lock = await http(
    `/v1/operator/accounts/${user.accountId}/lock`,
    { reason: 'CONFIRMED_FRAUD' },
    operator,
    null,
  );
  assert.equal(lock.status, 200);
  const [mark] = await q(
    'SELECT sessions_revoked_at::text AS mark, floor(extract(epoch FROM sessions_revoked_at))::bigint::text AS seconds FROM users WHERE id=$1',
    [user.userId],
  );
  assert.ok(mark.mark);
  const [effects] = await q(
    "SELECT (SELECT count(*)::int FROM audit_log WHERE correlation_id=$1 AND action='account.lock' AND outcome='SUCCESS') AS audits, (SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$2 AND event_type='AccountStatusChanged') AS events",
    [lock.correlationId, user.accountId],
  );
  assert.deepEqual(effects, { audits: 1, events: 1 });
  const seconds = Number(mark.seconds);
  const same = await token(seconds);
  revoked(await get(`/v1/accounts/${activeId}`, same));
  revoked(await get('/v1/identity/me', same));
  console.log(JSON.stringify({ committedRevocation: mark, effects, controlledIat: seconds }));
  pass(
    'M-115-02',
    'Committed lock; same-second signed token401 SESSION_REVOKED on ACTIVE B and identity/me, not expired',
  );

  const next = await token(seconds + 1);
  const allowed = await get(`/v1/accounts/${activeId}`, next);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.id, activeId);
  assert.equal(allowed.body.status, 'ACTIVE');
  assert.equal(allowed.body.balance, '1000000');
  const states = await q(
    'SELECT id,status,balance::text FROM accounts WHERE id IN ($1,$2) ORDER BY id',
    [user.accountId, activeId],
  );
  assert.equal(states.find(row => row.id === user.accountId).status, 'LOCKED');
  assert.equal(states.find(row => row.id === activeId).status, 'ACTIVE');
  assert.equal(
    (await q('SELECT sessions_revoked_at::text AS mark FROM users WHERE id=$1', [user.userId]))[0]
      .mark,
    mark.mark,
  );
  revoked(await get(`/v1/accounts/${activeId}`, same));
  console.log(JSON.stringify({ controlledNextIat: seconds + 1, accountStates: states }));
  await invariant();
  pass(
    'M-115-03',
    'Next-second signed token GET B200 ACTIVE; A remains LOCKED, mark and money unchanged, old token still401',
  );

  const [{ base }] = await q(
    "SELECT to_char(date_trunc('second', clock_timestamp()) - interval '10 seconds', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS base",
  );
  for (const fraction of ['000000', '001000', '999999']) {
    const input = `${base}.${fraction}Z`;
    // Auth-state INPUT only; account balances, ledger, audit and outbox are untouched by SQL.
    await q('UPDATE users SET sessions_revoked_at=$2::timestamptz WHERE id=$1', [
      user.userId,
      input,
    ]);
    const [row] = await q(
      "SELECT floor(extract(epoch FROM sessions_revoked_at))::bigint::text AS seconds,to_char(sessions_revoked_at,'US') AS micros FROM users WHERE id=$1",
      [user.userId],
    );
    assert.equal(row.micros, fraction);
    const value = Number(row.seconds);
    revoked(await get(`/v1/accounts/${activeId}`, await token(value)));
    const accepted = await get(`/v1/accounts/${activeId}`, await token(value + 1));
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, 'ACTIVE');
    assert.equal(accepted.body.balance, '1000000');
    console.log(
      JSON.stringify({
        sqlAuthInput: input,
        storedMicros: row.micros,
        sameIat: value,
        nextIat: value + 1,
        sameStatus: 401,
        nextStatus: 200,
      }),
    );
  }
  await invariant();
  pass(
    'M-115-04',
    'All .000000/.001000/.999999 SQL auth inputs: same401, next200; no clock change or sleeps; invariantsPASS',
  );
});
