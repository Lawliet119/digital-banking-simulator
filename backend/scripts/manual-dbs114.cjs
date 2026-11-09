const { resolve } = require('node:path');
process.chdir(resolve(__dirname, '..'));
process.env.NODE_ENV = 'test';
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { activeTransactionContext } = require('../src/database/transaction.helper');
const { createSessionRevocationFixture } = require('../test/support/session-revocation');

async function main() {
  console.log(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  console.log('DBS-114 real PG17 / Valkey / local JWT / operator lock / cache failures');
  let f;
  try {
    f = await createSessionRevocationFixture();
    await f.fresh();
    const [role] = await f.current().source.query('SELECT current_user,session_user');
    assert.deepEqual(role, { current_user: 'dbs_api', session_user: 'dbs_api' });
    const before = await f.me();
    assert.equal(before.status, 200);
    assert.equal(await f.admin.get(f.key()), null);
    await f.invariants();
    console.log(
      'M01 PASS: actual role=',
      JSON.stringify(role),
      'customer/account=',
      f.actor().userId,
      f.actor().accountId,
      'funded via HTTP1000000; GET200; no negative marker; invariants=PASS',
    );

    assert.equal((await f.lock()).status, 200);
    const marker = await f.marker(),
      ttl = await f.admin.ttl(f.key());
    assert.equal(await f.admin.get(f.key()), String(marker));
    assert.ok(ttl > 0 && ttl <= 900);
    const revoked = await f.me();
    f.assertRevoked(revoked);
    assert.equal((await f.unlock()).status, 200);
    f.assertRevoked(await f.me());
    const other = await f.otherCustomer();
    assert.equal((await f.me(undefined, other.token)).status, 200);
    assert.equal(await f.admin.get(`revoked_at:${other.userId}`), null);
    await f.invariants();
    console.log(
      `M02 PASS: lock200, epochSeconds=${marker}, TTL=${ttl}; next request401 SESSION_REVOKED, correlationId=${revoked.correlationId}; unlock does not revive old token; other user200; invariants=PASS`,
    );

    await f.admin.flushDb();
    f.assertRevoked(await f.me());
    assert.equal(await f.admin.get(f.key()), String(await f.marker()));
    f.proxy.setDelay(250);
    const started = Date.now();
    f.assertRevoked(await f.me());
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500);
    f.proxy.setDelay(0);
    const recoveredClient = await f.second();
    f.assertRevoked(await f.me(recoveredClient));
    await f.invariants();
    console.log(
      `M03 PASS: flush/miss401 via SQL and positive fill; real TCP delay250ms ->401 in ${elapsed}ms; reset delay/new client ->401; invariants=PASS`,
    );

    await f.fresh();
    await f.stopRedis();
    assert.equal((await f.lock()).status, 200);
    assert.equal(await f.accountStatus(), 'LOCKED');
    assert.ok((await f.marker()) > 0);
    f.assertRevoked(await f.me());
    await f.startRedis();
    const restartedClient = await f.second();
    f.assertRevoked(await f.me(restartedClient));
    assert.equal(await f.admin.get(f.key()), String(await f.marker()));
    await f.invariants();
    console.log(
      'M04 PASS: stopped real Valkey; lock still COMMIT200; next request401 via SQL; restart with refreshed mapped port/proxy/client ->401; invariants=PASS',
    );

    await f.fresh();
    await f.installAuditFault('rollback');
    assert.equal((await f.lock()).status, 500);
    assert.equal(await f.accountStatus(), 'ACTIVE');
    assert.equal(await f.marker(), null);
    assert.equal(await f.admin.get(f.key()), null);
    assert.deepEqual(await f.effects(), { audit: 0, events: 0 });
    await f.invariants();
    console.log(
      'M05 rollback PASS: forced audit failure500, status ACTIVE, SQL/cache marker absent, no lock audit/event; invariants=PASS',
    );

    await f.fresh();
    await f.installAuditFault('retry');
    const client = f.redis(),
      real = client.set.bind(client),
      writes = [];
    client.set = async (key, value, seconds) => {
      if (key === f.key())
        writes.push({
          attempt: await f.attempts(),
          inside: !!activeTransactionContext.getStore(),
          visible: await f.marker(),
          value,
        });
      return real(key, value, seconds);
    };
    try {
      assert.equal((await f.lock()).status, 200);
    } finally {
      client.set = real;
    }
    assert.equal(await f.attempts(), 2);
    assert.deepEqual(writes, [
      { attempt: 2, inside: false, visible: await f.marker(), value: String(await f.marker()) },
    ]);
    assert.deepEqual(await f.effects(), { audit: 1, events: 1 });
    await f.invariants();
    console.log(
      'M05 retry PASS: real SQLSTATE40001 attempt1 rolled back; attempt2 committed; exactly one SET observed=',
      JSON.stringify(writes),
      'one audit/event; invariants=PASS',
    );

    await f.fresh();
    await f.seedOlderRevocation();
    const second = await f.second();
    assert.equal((await f.me(second)).status, 200);
    const stale = await f.admin.get(f.key());
    try {
      await f.denySet();
      assert.equal((await f.lock()).status, 200);
      assert.equal(await f.admin.get(f.key()), stale);
      assert.ok(Number(stale) < (await f.marker()));
      const refused = await f.me(second);
      f.assertRevoked(refused);
      console.log(
        `M05 stale-cache PASS: SQL INPUT old committed auth mark/cache=${stale}; real ACL denies SET; lockA200, SQLmark=${await f.marker()}, API-B401 SESSION_REVOKED correlationId=${refused.correlationId}`,
      );
    } finally {
      await f.allowSet();
    }
    await f.invariants();
  } finally {
    if (f) {
      const ids = f.containerIds;
      await f.close();
      for (const id of ids)
        assert.equal(
          execFileSync('docker', ['ps', '-aq', '--filter', `id=${id}`], {
            encoding: 'utf8',
            windowsHide: true,
          }).trim(),
          '',
        );
      console.log(
        'M06 PASS: apps/pools/proxy/admin closed; owned PG/Valkey containers removed; shared Compose untouched',
      );
    }
  }
  console.log(
    'RESULT PASS:6/6 manual steps; no token/password output; money only via HTTP; no AWS',
  );
}
main().catch(error => {
  console.error('MANUAL FAILED:', error.name, error.code ?? '', error.message);
  process.exitCode = 1;
});
