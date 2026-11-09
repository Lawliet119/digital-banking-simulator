import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { createClient } from 'redis';
import { DataSource } from 'typeorm';
import { RedisClient, RedisMetrics } from '@libs/redis';
import { LATEST_KEY, RuleSetRepository } from '@modules/risk/config/rule-set.repository';
import { RiskMetrics } from '@modules/risk/risk.metrics';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startPostgresContainer, stopPostgresContainer } from '../support/postgres.container';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';

/** Run with ts-node/tsconfig-paths. Uses only disposable PostgreSQL and Valkey containers. */
async function main(): Promise<void> {
  let db: TempDatabase | undefined;
  let valkey: StartedValkey | undefined;
  let source: DataSource | undefined;
  let cache: RedisClient | undefined;
  let admin: ReturnType<typeof createClient> | undefined;
  try {
    process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
    valkey = await startValkeyContainer();
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    cache = new RedisClient({ url: valkey.url, commandTimeoutMs: 50 }, new RedisMetrics());
    admin = createClient({ url: valkey.url });
    admin.on('error', () => undefined);
    await admin.connect();
    const limit = Date.now() + 5000;
    while (!cache.isReady) {
      if (Date.now() >= limit) throw new Error('Valkey not ready');
      await wait(10);
    }
    const metrics = new RiskMetrics();
    const repository = new RuleSetRepository({ redis: cache, db: source, metrics });
    const initial = await repository.current();
    assert.equal(initial.version, 1);
    console.log('M-CACHE-01 PASS: seed v1 selected from isolated PostgreSQL');

    await admin.del(LATEST_KEY);
    let release: (() => void) | undefined;
    let selected: (() => void) | undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const selectedSignal = new Promise<void>(resolve => {
      selected = resolve;
    });
    const dbSource = source;
    const slowDb = {
      query: async (sql: string, params?: unknown[]): Promise<unknown> => {
        const rows = await dbSource.query<unknown[]>(sql, params);
        if (sql.includes('ORDER BY')) {
          selected?.();
          await held;
        }
        return rows;
      },
    };
    const slow = new RuleSetRepository({ redis: cache, db: slowDb, metrics }).current();
    try {
      await selectedSignal;
      await source.query(
        'INSERT INTO risk_rule_sets(version,config) SELECT 2,config FROM risk_rule_sets WHERE version=1',
      );
      assert.equal((await repository.current()).version, 2);
      release?.();
      assert.equal((await slow).version, 1);
      assert.equal((await repository.current()).version, 2);
      console.log('M-CACHE-02 PASS: delayed v1 cannot replace published v2');
    } finally {
      release?.();
      await slow.catch(() => undefined);
    }

    await source.query(
      'INSERT INTO risk_rule_sets(version,config) SELECT 3,config FROM risk_rule_sets WHERE version=1',
    );
    await admin.pExpire(LATEST_KEY, 100);
    await wait(200);
    assert.equal((await repository.current()).version, 3);
    console.log('M-CACHE-03 PASS: v3 selected after shortened cache expiry');
    admin.destroy();
    await valkey.stop();
    valkey = undefined;
    assert.equal((await repository.current()).version, 3);
    console.log('M-CACHE-04 PASS: PostgreSQL returns v3 with Valkey stopped');
  } finally {
    cache?.onModuleDestroy();
    if (admin?.isOpen) admin.destroy();
    await source?.destroy();
    await db?.drop();
    await valkey?.stop();
    await stopPostgresContainer();
  }
}

void main().catch((error: unknown) => {
  console.error(
    'Risk configuration smoke failed:',
    error instanceof Error ? error.name : 'unknown',
  );
  process.exitCode = 1;
});
