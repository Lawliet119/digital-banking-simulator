import { setTimeout as wait } from 'node:timers/promises';
import { createClient } from 'redis';
import { DataSource } from 'typeorm';
import { RedisClient, RedisMetrics } from '@libs/redis';
import { LATEST_KEY, RuleSetRepository } from '@modules/risk/config/rule-set.repository';
import { RiskMetrics } from '@modules/risk/risk.metrics';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
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
const version = (r1Weight: number) => ({
  mode: 'rule_only',
  thresholds: { medium: 40, high: 70 },
  rules: rules(r1Weight),
});

/** DBS-110: configuration reads keep working, and stay exact, with Redis fresh, expired or gone. */
describe('RuleSetRepository (real PostgreSQL + Valkey)', () => {
  let valkey: StartedValkey;
  let admin: ReturnType<typeof createClient>;
  let db: TempDatabase;
  let source: DataSource;
  let client: RedisClient;
  let metrics: RiskMetrics;
  let repository: RuleSetRepository;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;
  const addVersion = (n: number, r1Weight: number) =>
    q('INSERT INTO risk_rule_sets(version,config) VALUES($1,$2::jsonb)', [
      n,
      JSON.stringify(version(r1Weight)),
    ]);

  beforeAll(async () => {
    valkey = await startValkeyContainer();
    admin = createClient({ url: valkey.url });
    admin.on('error', () => undefined);
    await admin.connect();
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    client = new RedisClient({ url: valkey.url, commandTimeoutMs: 50 }, new RedisMetrics());
    const deadline = Date.now() + 10_000;
    while (!client.isReady && Date.now() < deadline) await wait(20);
  });
  afterAll(async () => {
    client?.onModuleDestroy();
    if (admin?.isOpen) admin.destroy();
    await source?.destroy();
    await db?.drop();
    await valkey?.stop();
  });
  beforeEach(async () => {
    await admin.flushAll();
    metrics = new RiskMetrics();
    repository = new RuleSetRepository({ redis: client, db: source, metrics });
  });

  async function healthy(): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        await client.ping();
        return;
      } catch {
        if (Date.now() > deadline) throw new Error('Valkey did not come back');
        await wait(250);
      }
    }
  }

  const nextVersion = async (): Promise<number> =>
    Number((await q('SELECT max(version) AS version FROM risk_rule_sets'))[0].version) + 1;

  it('TC-110-01 keys: latest lives at most 60 s and no rule-set content is written to Redis', async () => {
    const set = await repository.current();
    expect(set.version).toBe(1);
    const latestTtl = await admin.ttl(LATEST_KEY);
    expect(latestTtl).toBeGreaterThan(0);
    expect(latestTtl).toBeLessThanOrEqual(60);
    expect(await admin.keys('cfg:risk:v*')).toEqual([]);
  });

  it('TC-110-02 a new version is used once latest expires (at most 60 s), not sooner', async () => {
    await repository.current();
    await addVersion(2, 55);
    // Within the minute the old version is still the one in use: that is the contract.
    expect(
      (await new RuleSetRepository({ redis: client, db: source, metrics }).current()).version,
    ).toBe(1);
    // "60 seconds later": the key expires. (Valkey drops it after the shortened TTL.)
    await admin.pExpire(LATEST_KEY, 1);
    await wait(30);
    const fresh = await new RuleSetRepository({ redis: client, db: source, metrics }).current();
    expect(fresh.version).toBe(2);
    expect(fresh.rules.R1.weight).toBe(55);
  });

  it('TC-110-03 with Redis paused the right version is read from PostgreSQL, immediately', async () => {
    await repository.current();
    await valkey.pause();
    try {
      await addVersion(3, 61);
      const fresh = new RuleSetRepository({ redis: client, db: source, metrics });
      const set = await fresh.current();
      expect(set.version).toBe(3); // no cache, so no 60 s wait either
      expect(set.rules.R1.weight).toBe(61);
      expect(await metrics.configFallbackCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await valkey.resume();
    }
    await healthy();
    // Redis is back: the next cold read stores version 3 again.
    await admin.flushAll();
    expect(
      (await new RuleSetRepository({ redis: client, db: source, metrics }).current()).version,
    ).toBe(3);
  });

  it('TC-110-03 BL-208 a Redis entry that is valid but differs from PostgreSQL is never scored', async () => {
    const n = await nextVersion();
    await addVersion(n, 77);
    const deadline = (await client.serverTimeMs()) + 5000;
    await client.setVersionBefore(LATEST_KEY, n, deadline);
    // The old content cache: a well-formed rule set for this version that PostgreSQL does not hold.
    await admin.set(`cfg:risk:v${n}`, JSON.stringify(version(99)), { EX: 60 });
    const reader = new RuleSetRepository({ redis: client, db: source, metrics });
    const set = await reader.current();
    expect(set.version).toBe(n);
    expect(set.rules.R1.weight).toBe(77);
    // And it is not pinned in memory: the same reader keeps answering from the PostgreSQL row.
    expect((await reader.current()).rules.R1.weight).toBe(77);
  });

  it('BL-208 a latest outside int4 or junk falls back to PostgreSQL, is counted corrupt, and is repaired', async () => {
    const n = await nextVersion();
    await addVersion(n, 78);
    for (const junk of ['9999999999', '9999999999:99999999999999', 'x', '{"v":3}']) {
      await admin.flushAll();
      await admin.set(LATEST_KEY, junk, { PX: 5000 });
      const m = new RiskMetrics();
      const set = await new RuleSetRepository({ redis: client, db: source, metrics: m }).current();
      expect([junk, set.version]).toEqual([junk, n]);
      expect([junk, await m.configFallbackCount('corrupt')]).toEqual([junk, 1]);
      expect((await client.readExpiringVersion(LATEST_KEY))?.version).toBe(n);
    }
  });

  it('BL-208 a Redis failure is labelled error, not corrupt', async () => {
    await repository.current();
    await valkey.pause();
    try {
      const m = new RiskMetrics();
      await new RuleSetRepository({ redis: client, db: source, metrics: m }).current();
      expect(await m.configFallbackCount('error')).toBeGreaterThanOrEqual(1);
      expect(await m.configFallbackCount('corrupt')).toBe(0);
    } finally {
      await valkey.resume();
    }
    await healthy();
  });

  it('does not let an older SQL read or a legacy writer replace a newer cached version', async () => {
    const [{ version: current }] = await q('SELECT max(version) AS version FROM risk_rule_sets');
    const newVersion = Number(current) + 1;
    let release: (() => void) | undefined;
    let selected: (() => void) | undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const snapshotSelected = new Promise<void>(resolve => {
      selected = resolve;
    });
    const slowDb = {
      query: async (sql: string, params?: unknown[]): Promise<unknown> => {
        const result = await source.query<unknown[]>(sql, params);
        if (sql.includes('ORDER BY')) {
          selected?.();
          await held;
        }
        return result;
      },
    };
    const oldRead = new RuleSetRepository({ redis: client, db: slowDb, metrics }).current();
    try {
      await snapshotSelected;
      await addVersion(newVersion, 67);
      expect(
        (await new RuleSetRepository({ redis: client, db: source, metrics }).current()).version,
      ).toBe(newVersion);
      // A legacy worker can still publish an obsolete bare version on the original key.
      await admin.set('cfg:risk:latest', String(current), { EX: 60 });
      release?.();
      expect((await oldRead).version).toBe(Number(current));
      expect(
        (await new RuleSetRepository({ redis: client, db: source, metrics }).current()).version,
      ).toBe(newVersion);
    } finally {
      release?.();
      await oldRead.catch(() => undefined);
    }
  });
});
