// From backend/: DATABASE_URL=<postgres server> npx ts-node -r tsconfig-paths/register test/manual/rule-set-repository.manual.ts
// Needs `docker compose up -d` (Valkey on :6379, container dbs-valkey-1) and a PostgreSQL server for the throwaway DB.
// It uses the real keys cfg:risk:latest and cfg:risk:v{n} of the local Valkey and deletes them at the end.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { RedisClient, RedisMetrics } from '@libs/redis';
import {
  LATEST_KEY,
  RuleSetRepository,
  versionKey,
} from '@modules/risk/config/rule-set.repository';
import { RiskMetrics } from '@modules/risk/risk.metrics';
import { createTempDatabase, migrate } from '../support/temp-database';

const CONTAINER = 'dbs-valkey-1';
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
  let source: DataSource | undefined;
  let client: RedisClient | undefined;
  let paused = false;
  try {
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    client = new RedisClient(
      { url: 'redis://localhost:6379', commandTimeoutMs: 50 },
      new RedisMetrics(),
    );
    while (!client.isReady) await wait(20);
    for (const key of [LATEST_KEY, versionKey(1), versionKey(2), versionKey(3)])
      await client.del(key);
    const metrics = new RiskMetrics();
    const fresh = () => new RuleSetRepository({ redis: client!, db: source!, metrics });
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
    assert.ok(await client.get(versionKey(1)));
    console.log(
      `M-110-01 PASS: current version ${first.version} (R1 weight ${first.rules.R1.weight}); ${LATEST_KEY} and ${versionKey(1)} stored`,
    );

    // M-110-02: version 2 appears; the cache keeps v1 until latest expires.
    await add(2, 55);
    assert.equal((await fresh().current()).version, 1);
    execFileSync('docker', ['exec', CONTAINER, 'valkey-cli', 'PEXPIRE', LATEST_KEY, '1']);
    await wait(50);
    const second = await fresh().current();
    assert.equal(second.version, 2);
    assert.equal(second.rules.R1.weight, 55);
    console.log(
      `M-110-02 PASS: v2 added; still v1 inside the cache window, v2 (R1 weight ${second.rules.R1.weight}) once ${LATEST_KEY} expired`,
    );

    // M-110-03: Valkey paused, version 3 added: read straight from PostgreSQL.
    execFileSync('docker', ['pause', CONTAINER]);
    paused = true;
    await add(3, 61);
    const during = await fresh().current();
    assert.equal(during.version, 3);
    assert.equal(during.rules.R1.weight, 61);
    execFileSync('docker', ['unpause', CONTAINER]);
    paused = false;
    console.log(
      `M-110-03 PASS: Valkey paused -> version ${during.version} read from PostgreSQL at once (config fallbacks=${await metrics.configFallbackCount()})`,
    );
  } finally {
    if (paused) execFileSync('docker', ['unpause', CONTAINER]);
    if (client) {
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          await client.ping();
          break;
        } catch {
          await wait(250);
        }
      }
      for (const key of [LATEST_KEY, versionKey(1), versionKey(2), versionKey(3)])
        await client.del(key).catch(() => undefined);
      client.onModuleDestroy();
    }
    await source?.destroy();
    await db.drop();
    console.log('cleanup done: temp database dropped, cfg:risk keys deleted');
  }
}

main().catch((error: unknown) => {
  console.error('FAILED', error);
  process.exitCode = 1;
});
