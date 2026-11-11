// Isolated local drill; real HTTP/JWT/PG17/Valkey. Never prints tokens or connection URLs.
const { resolve } = require('node:path');
process.chdir(resolve(__dirname, '..'));
process.env.NODE_ENV = 'test';
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createSessionRevocationFixture } = require('../test/support/session-revocation');

async function main() {
  console.log(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  console.log('DBS-186 LOCAL ONLY; PG17 / Valkey / JWT / HTTP; cloud NOT RUN');
  let f;
  let ids = [];
  const show = (step, result) => console.log(step, JSON.stringify(result));
  try {
    f = await createSessionRevocationFixture();
    ids = f.containerIds;
    const stamp = async () => {
      const [row] = await f.owner.query(
        'SELECT sessions_revoked_at::text AS stamp FROM users WHERE id=$1',
        [f.actor().userId],
      );
      return row.stamp;
    };
    for (const mode of ['flush', 'down']) {
      await f.fresh();
      const [role] = await f.current().source.query('SELECT current_user,session_user');
      assert.deepEqual(role, { current_user: 'dbs_api', session_user: 'dbs_api' });
      const other = await f.otherCustomer();
      assert.equal((await f.me()).status, 200);
      assert.equal(await f.marker(), null);
      await f.invariants();
      show('M-186-01 PASS', {
        mode,
        role,
        accountId: f.actor().accountId,
        GET: 200,
        invariant: 'PASS',
      });
      assert.equal((await f.lock()).status, 200);
      const mark = await f.marker();
      const before = await stamp();
      assert.equal(await f.admin.get(f.key()), String(mark));
      if (mode === 'flush') {
        await f.admin.flushDb();
        assert.equal(await f.admin.ping(), 'PONG');
        assert.equal(await f.admin.get(f.key()), null);
      } else await f.stopRedis();
      const response = await f.me();
      f.assertRevoked(response);
      assert.equal(await stamp(), before);
      assert.equal(await f.accountStatus(), 'LOCKED');
      assert.deepEqual(await f.effects(), { audit: 1, events: 1 });
      assert.equal((await f.me(undefined, other.token)).status, 200);
      show(mode === 'flush' ? 'M-186-02 PASS' : 'M-186-03 PASS', {
        mode,
        sqlTimestamp: before,
        nextRequest: response,
        userB: 200,
        audit: 1,
        outbox: 1,
      });
      let recoveryMs = 0;
      if (mode === 'down') {
        const start = Date.now();
        await f.startRedis();
        const recovered = await f.second();
        f.assertRevoked(await f.me(recovered));
        recoveryMs = Date.now() - start;
      }
      assert.equal(await f.admin.get(f.key()), String(mark));
      assert.equal(await stamp(), before);
      await f.invariants();
      show('RECOVERY PASS', { mode, recoveryMs, markerUnchanged: true, invariant: 'PASS' });
    }
    for (const mode of ['hit', 'flush', 'down']) {
      await f.fresh();
      const app = f.current();
      const originalToken = await f.token(f.actor().issuedAt);
      const opened = await fetch(`${app.url}/v1/accounts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${originalToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'SAVINGS' }),
      });
      assert.equal(opened.status, 201);
      const accountB = await opened.json();
      assert.equal((await f.lock()).status, 200);
      const mark = await f.marker();
      const before = await stamp();
      assert.equal(await f.admin.get(f.key()), String(mark));
      if (mode === 'down') await f.stopRedis();
      for (const delta of [0, 1]) {
        if (mode === 'flush') {
          await f.admin.flushDb();
          assert.equal(await f.admin.ping(), 'PONG');
          assert.equal(await f.admin.get(f.key()), null);
        }
        const token = await app.issuer.token('customer', {
          sub: f.actor().sub,
          iat: mark + delta,
          exp: Math.floor(Date.now() / 1000) + 900,
        });
        const res = await fetch(`${app.url}/v1/accounts/${accountB.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const result = {
          status: res.status,
          body: await res.json(),
          correlationId: res.headers.get('x-correlation-id'),
        };
        if (delta === 0) f.assertRevoked(result);
        else {
          assert.equal(res.status, 200);
          assert.equal(result.body.id, accountB.id);
          assert.equal(result.body.status, 'ACTIVE');
        }
        assert.equal(await stamp(), before);
        assert.equal(await f.accountStatus(), 'LOCKED');
        show('M-186-04 PASS', { mode, delta, sqlTimestamp: before, accountA: 'LOCKED', result });
      }
      assert.equal((await f.unlock()).status, 200);
      f.assertRevoked(await f.me(undefined, await f.token(mark)));
      assert.equal(await stamp(), before);
      await f.invariants();
      show('UNLOCK PASS', { mode, oldSession: 'SESSION_REVOKED', invariant: 'PASS' });
    }
  } finally {
    await f?.close();
    for (const id of ids)
      assert.equal(
        execFileSync('docker', ['ps', '-aq', '--filter', `id=${id}`], {
          encoding: 'utf8',
          windowsHide: true,
        }).trim(),
        '',
      );
    console.log('M-186-05 PASS: owned containers removed, pools/proxy/admin closed');
  }
  console.log('RESULT PASS: local drill; M-186-06 cloud NOT RUN; M-186-07 recorded separately');
}
main().catch(error => {
  console.error('MANUAL FAILED:', error.name, error.code ?? '', error.message);
  process.exitCode = 1;
});
