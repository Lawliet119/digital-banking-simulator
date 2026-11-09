const { resolve } = require('node:path');
process.chdir(resolve(__dirname, '..'));
process.env.NODE_ENV = 'test';
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createDedupCleanupFixture, DAY } = require('../test/support/dedup-cleanup');

async function main() {
  console.log(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  console.log('DBS-136 real PostgreSQL17 / actual worker LOGIN / cleanup lifecycle / HTTP replay');
  let f;
  try {
    f = await createDedupCleanupFixture();
    const [role] = await f.worker.query('SELECT current_user,session_user');
    assert.deepEqual(role, { current_user: 'dbs_worker', session_user: 'dbs_worker' });
    console.log(
      'M01 SQL INPUT: dedup metadata only; no financial SQL seed. role=',
      JSON.stringify(role),
    );
    await f.seedBoundaries();
    const first = await f.lifecycle('worker');
    assert.equal(first.idempotency, 1);
    assert.equal(first.processed, 1);
    assert.deepEqual(await f.labels(), {
      keys: ['boundary', 'fresh'],
      marks: ['boundary', 'fresh'],
    });
    console.log(
      'M01 PASS: before-cutoff 1us deleted; exact cutoff and +1us retained:',
      JSON.stringify(await f.labels()),
    );

    await f.reset();
    await f.seedMany(25);
    const batch = await f.job().cleanOnce({
      batchSize: 10,
      maxBatches: 2,
      pauseMs: 0,
      afterBatch: async () => {
        const open = await f.owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name='dbs136-worker' AND state='idle in transaction'",
        );
        assert.deepEqual(open, []);
      },
    });
    assert.equal(batch.idempotency, 20);
    assert.equal(batch.processed, 20);
    assert.equal(batch.truncated, true);
    assert.deepEqual(await f.counts(), { keys: 5, marks: 5 });
    console.log(
      'M02 budget PASS:',
      JSON.stringify(batch),
      'remaining=',
      JSON.stringify(await f.counts()),
      'no idle transaction between batches',
    );
    const rest = await f.job().cleanOnce({ pauseMs: 0 });
    assert.equal(rest.idempotency, 5);
    assert.equal(rest.processed, 5);
    console.log('M02 resume PASS: removed final five from each table');

    await f.reset();
    await f.seedAge('ready', 9);
    await f.seedAge('locked', 8);
    const locker = f.owner.createQueryRunner();
    await locker.startTransaction();
    let code, elapsed;
    try {
      await locker.query("SELECT 1 FROM idempotency_keys WHERE idem_key='locked' FOR UPDATE");
      const started = Date.now();
      await assert.rejects(
        () => f.job().cleanOnce({ pauseMs: 0 }),
        error => {
          code = error.code;
          return code === '55P03';
        },
      );
      elapsed = Date.now() - started;
      assert.ok(elapsed < 3000);
      assert.equal((await f.counts()).keys, 2);
    } finally {
      await locker.rollbackTransaction();
      await locker.release();
    }
    const recovered = await f.job().cleanOnce({ pauseMs: 0 });
    assert.equal(recovered.idempotency, 2);
    console.log(
      `M03 PASS: SQLSTATE=${code}, elapsed=${elapsed}ms, locked batch rolled back two keys; release/retry removed two`,
    );

    await f.reset();
    const key = randomUUID(),
      original = await f.deposit(key);
    const [{ created_at: created }] = await f.owner.query(
      'SELECT created_at FROM idempotency_keys WHERE idem_key=$1',
      [key],
    );
    f.clock.instant = new Date(created.getTime() + 7 * DAY);
    assert.equal((await f.job().cleanOnce({ pauseMs: 0 })).idempotency, 0);
    assert.deepEqual(await f.deposit(key), original);
    await f.invariants();
    console.log(
      'M04 replay PASS: retained key, identical response, transferId=',
      original.transferId,
      'invariants=PASS',
    );
    f.clock.instant = new Date(f.clock.instant.getTime() + 1);
    assert.equal((await f.job().cleanOnce({ pauseMs: 0 })).idempotency, 1);
    const next = await f.deposit(key);
    assert.notEqual(next.transferId, original.transferId);
    const [{ balance }] = await f.owner.query('SELECT balance FROM accounts WHERE id=$1', [
      f.accountId,
    ]);
    assert.equal(balance, '2000000');
    await f.invariants();
    console.log(
      'M04 expiry PASS: after removal a new command is allowed, transferId=',
      next.transferId,
      'balance=',
      balance,
      'invariants=PASS',
    );

    await f.reset();
    await f.seedMany(25);
    const job = f.job();
    const partial = await job.cleanOnce({
      batchSize: 10,
      pauseMs: 0,
      afterBatch: async () => {
        if ((await f.counts()).marks < 25) await job.onApplicationShutdown();
      },
    });
    assert.equal(partial.truncated, true);
    assert.deepEqual(await f.counts(), { keys: 25, marks: 15 });
    await f.lifecycle('api');
    assert.deepEqual(await f.counts(), { keys: 25, marks: 15 });
    await f.lifecycle('worker');
    assert.deepEqual(await f.counts(), { keys: 0, marks: 0 });
    await f.invariants();
    console.log(
      'M05 PASS: shutdown leaves25 keys/15 marks; API does not clean; restarted worker drains remainder; invariants=PASS',
    );
  } finally {
    if (f) {
      const id = f.containerId;
      await f.close();
      assert.equal(
        execFileSync('docker', ['ps', '-aq', '--filter', `id=${id}`], { encoding: 'utf8' }).trim(),
        '',
      );
      assert.equal(f.worker.isInitialized, false);
      assert.equal(f.owner.isInitialized, false);
      console.log(
        'M06 PASS: application/pools closed; owned PostgreSQL removed; shared Compose untouched',
      );
    }
  }
  console.log('RESULT PASS: 6/6 manual steps; no AWS and no shared role changes');
}
main().catch(error => {
  console.error('MANUAL FAILED:', error.name, error.code ?? '', error.message);
  process.exitCode = 1;
});
