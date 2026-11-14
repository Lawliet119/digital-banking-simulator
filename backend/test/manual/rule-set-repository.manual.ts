// From backend/: DATABASE_URL=<postgres server> npx ts-node -r tsconfig-paths/register test/manual/rule-set-repository.manual.ts
// Needs Docker (a disposable Valkey container is started and removed by the script) and a PostgreSQL
// server for the throwaway DB. BL-212: it no longer writes into the shared compose Valkey, so a local
// worker on the compose PostgreSQL can never read the throwaway versions of this script.
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { DataSource } from 'typeorm';
import { RedisClient, RedisMetrics } from '@libs/redis';
import { LATEST_KEY, RuleSetRepository } from '@modules/risk/config/rule-set.repository';
import { RiskMetrics } from '@modules/risk/risk.metrics';
import { until } from '../support/manual-wait';
import { createTempDatabase, migrate } from '../support/temp-database';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';

const rules = (r1Weight: number) => ({
  R1: { enabled: true, weight: r1Weight, maxTransfers: 5, windowMinutes: 10 },
  R2: { enabled: true, weight: 25, medianMultiplier: 5, historyDays: 30, minHistory: 5 },
  R3: {
    enabled: true,
    weight: 35,
    maxAccountAgeHoursExclusive: 24,
    minAmountExclusive: '10000000',
  },
  R4: { enabled: true, weight: 20, reverseWindowMinutes: 60 },
  R5: { enabled: true, weight: 40, minNewRecipients: 5, windowMinutes: 60, noveltyDays: 30 },
  R6: { enabled: true, weight: 30, minBalancePercent: 90, minBalance: '1000000' },
});

async function main(): Promise<void> {
  const db = await createTempDatabase();
  let valkey: StartedValkey | undefined;
  let source: DataSource | undefined;
  let client: RedisClient | undefined;
  let admin: ReturnType<typeof createClient> | undefined;
  let paused = false;
  try {
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    valkey = await startValkeyContainer();
    client = new RedisClient({ url: valkey.url, commandTimeoutMs: 50 }, new RedisMetrics());
    admin = createClient({ url: valkey.url });
    admin.on('error', () => undefined);
    await admin.connect();
    await until(() => client!.isReady, 'Valkey to accept the client', 10_000, 20);
    const metrics = new RiskMetrics();
    const fresh = (m = metrics) =>
      new RuleSetRepository({ redis: client!, db: source!, metrics: m });
    const add = (n: number, r1Weight: number) =>
      source!.query('INSERT INTO risk_rule_sets(version,config) VALUES($1,$2::jsonb)', [
        n,
        JSON.stringify({
          mode: 'rule_only',
          thresholds: { medium: 40, high: 70 },
          rules: rules(r1Weight),
        }),
      ]);

    // M-110-01: seed v1 from PostgreSQL, then cached.
    const first = await fresh().current();
    assert.equal(first.version, 1);
    assert.equal((await client.readExpiringVersion(LATEST_KEY))?.version, 1);
    console.log(
      `M-110-01 PASS: current version ${first.version} (R1 weight ${first.rules.R1.weight}); ${LATEST_KEY} stored`,
    );

    // M-110-02: version 2 appears; the cache keeps v1 until latest expires.
    await add(2, 55);
    assert.equal((await fresh().current()).version, 1);
    await admin.pExpire(LATEST_KEY, 1);
    await until(
      async () => (await admin!.exists(LATEST_KEY)) === 0,
      `${LATEST_KEY} to expire`,
      5000,
    );
    const second = await fresh().current();
    assert.equal(second.version, 2);
    assert.equal(second.rules.R1.weight, 55);
    console.log(
      `M-110-02 PASS: v2 added; still v1 inside the cache window, v2 (R1 weight ${second.rules.R1.weight}) once ${LATEST_KEY} expired`,
    );

    // M-110-03: Valkey paused, version 3 added: read straight from PostgreSQL.
    await valkey.pause();
    paused = true;
    await add(3, 61);
    const during = await fresh().current();
    assert.equal(during.version, 3);
    assert.equal(during.rules.R1.weight, 61);
    console.log(
      `M-110-03 PASS: Valkey paused -> version ${during.version} read from PostgreSQL at once (config fallbacks=${await metrics.configFallbackCount()})`,
    );

    // M-110-04 (BL-212): recovery. After the unpause the cache works again: a cold read stores
    // `latest` for version 3 and the next read is answered from it.
    await valkey.resume();
    paused = false;
    await until(
      async () => {
        try {
          await client!.ping();
          return true;
        } catch {
          return false;
        }
      },
      'Valkey to answer PING after the unpause',
      20_000,
      250,
    );
    await admin.del(LATEST_KEY);
    assert.equal((await fresh().current()).version, 3);
    assert.equal((await client.readExpiringVersion(LATEST_KEY))?.version, 3);
    console.log('M-110-04 PASS: Valkey back -> latest stored again for version 3');

    // M-110-05 (BL-212): the error path. A `latest` nobody wrote (junk, outside int4) is not
    // believed: the repository answers from PostgreSQL, counts it as corrupt, and repairs the key.
    for (const junk of ['9999999999', 'x', '{"v":3}']) {
      await admin.set(LATEST_KEY, junk, { PX: 5000 });
      const m = new RiskMetrics();
      const set = await fresh(m).current();
      assert.equal(set.version, 3, `junk "${junk}" must not change the answer`);
      assert.equal(await m.configFallbackCount('corrupt'), 1, `junk "${junk}" counted as corrupt`);
      assert.equal((await client.readExpiringVersion(LATEST_KEY))?.version, 3);
    }
    console.log(
      'M-110-05 PASS: junk latest ("9999999999", "x", JSON) -> PostgreSQL v3, counted corrupt, key repaired',
    );
  } finally {
    if (paused) await valkey?.resume().catch(() => undefined);
    client?.onModuleDestroy();
    if (admin?.isOpen) admin.destroy();
    await source?.destroy();
    await db.drop();
    await valkey?.stop();
    console.log('cleanup done: temp database dropped, disposable Valkey removed');
  }
}

main().catch((error: unknown) => {
  console.error('FAILED', error);
  process.exitCode = 1;
});
