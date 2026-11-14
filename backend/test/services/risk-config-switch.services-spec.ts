import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { createClient } from 'redis';
import { DataSource } from 'typeorm';
import { RedisClient, RedisMetrics } from '@libs/redis';
import { LATEST_KEY, LATEST_TTL_SECONDS } from '@modules/risk/config/rule-set.repository';
import type { RiskAiService } from '@modules/risk/ai/risk-ai.service';
import { startDepositApp, type DepositApp } from '../support/deposit-app';
import { buildRiskConsumer, eventFor, riskFixtures } from '../support/risk-consumer';
import { startPostgresContainer, stopPostgresContainer } from '../support/postgres.container';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';

const VALID_AI = {
  provider: 'openai',
  model: 'gpt-6-luna',
  rubric:
    'needs_operator_review: đánh giá mẫu giao dịch đã hoàn tất có dấu hiệu cần nhân viên xem xét',
  threshold: 0.8,
  weight: 20,
  maxAdmissionDelayMs: 2000,
  requestTimeoutMs: 3000,
};

/**
 * BL-239 (RSK-06 DoD 4, the Redis half): a rule-set switch while the real cache still holds the old
 * `latest` marker, with requests in flight. Since BL-208 Redis only says which version is current
 * (`cfg:risk:latest:v2`, 60 s); the content always comes from PostgreSQL. The contract being proven:
 * the new version takes effect only when the marker expires or is refreshed, never half way, and no
 * request fails on the way. "60 seconds later" is made by shortening the real key's TTL
 * (the repository's 60 s is a constant, and the deadline lives in Valkey's clock, not in ours).
 * `risk_rule_sets` is append-only, so the tests share one database and run in this order.
 */
describe('RSK-06 DoD 4 / BL-239: rule-set switch while Valkey caches the old latest version', () => {
  let valkey: StartedValkey;
  let admin: ReturnType<typeof createClient>;
  let redis: RedisClient;
  let db: TempDatabase;
  let app: DepositApp;
  let source: DataSource;
  let fx: ReturnType<typeof riskFixtures>;

  const aiCalls = jest.fn();
  const ai = {
    evaluate: (...args: unknown[]) => {
      aiCalls(...args);
      return Promise.resolve({
        status: 'UNAVAILABLE',
        probability: null,
        provider: 'openai',
        requestedModel: 'gpt-6-luna',
        responseModel: null,
        requestId: null,
        rubricSha256: 'a'.repeat(64),
        inputSha256: 'b'.repeat(64),
        usage: null,
      });
    },
  } as unknown as RiskAiService;

  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> =>
    db.runner.query(sql, args) as Promise<T[]>;

  /** AC-9.1: 20 of 21 million from a new account to another owner, MEDIUM under the seed rule set. */
  async function flaggable(label: string) {
    const sender = await fx.customer(`Gửi ${label}`);
    const recipient = await fx.customer(`Nhận ${label}`);
    await fx.deposit(sender.accounts[0], '21000000');
    const transferId = await fx.transfer(
      sender.token,
      sender.accounts[0],
      recipient.accounts[0],
      '20000000',
    );
    return { transferId, event: await eventFor(db.runner, transferId) };
  }
  type Sale = Awaited<ReturnType<typeof flaggable>>;
  const sales = async (prefix: string, count: number): Promise<Sale[]> => {
    const made: Sale[] = [];
    for (let i = 0; i < count; i++) made.push(await flaggable(`${prefix} ${i}`));
    return made;
  };

  const decisionsOf = (transferId: string) =>
    q<{ mode: string; rule_set_version: number }>(
      'SELECT mode, rule_set_version FROM risk_decisions WHERE transfer_id = $1',
      [transferId],
    );
  const countOf = async (sql: string, transferId: string): Promise<number> =>
    (await q(sql, [transferId])).length;
  const flagsOf = (transferId: string) =>
    countOf('SELECT 1 FROM fraud_flags WHERE transfer_id = $1', transferId);
  const auditsOf = (transferId: string) =>
    countOf(
      "SELECT 1 FROM audit_log WHERE target_id = $1 AND action = 'fraud.flagged'",
      transferId,
    );

  const cachedVersion = async (): Promise<number | undefined> =>
    (await redis.readExpiringVersion(LATEST_KEY))?.version;
  const latestInPostgres = async (): Promise<number> =>
    Number((await q('SELECT max(version) AS version FROM risk_rule_sets'))[0].version);

  /** Every transfer decided exactly once, with one flag and one audit row, under the given version. */
  async function expectDecided(batch: Sale[], mode: string, version: number): Promise<void> {
    for (const sale of batch) {
      expect(await decisionsOf(sale.transferId)).toEqual([{ mode, rule_set_version: version }]);
      expect(await flagsOf(sale.transferId)).toBe(1);
      expect(await auditsOf(sale.transferId)).toBe(1);
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
    valkey = await startValkeyContainer();
    admin = createClient({ url: valkey.url });
    admin.on('error', () => undefined);
    await admin.connect();
    // A generous command timeout: a Redis timeout would silently fall back to PostgreSQL and show
    // the new version early, which is exactly what this test must not confuse with the cache.
    redis = new RedisClient({ url: valkey.url, commandTimeoutMs: 1000 }, new RedisMetrics());
    const ready = Date.now() + 10_000;
    while (!redis.isReady) {
      if (Date.now() > ready) throw new Error('Valkey did not become ready');
      await wait(20);
    }
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, { fraud: true });
    fx = riskFixtures(app, await app.issuer.token('operator', { sub: randomUUID() }));
    source = await new DataSource({
      type: 'postgres',
      url: db.url,
      extra: { max: 20 },
    }).initialize();
  }, 180_000);

  afterAll(async () => {
    try {
      redis?.onModuleDestroy();
      if (admin?.isOpen) admin.destroy();
      await source?.destroy();
      await app?.close();
    } finally {
      try {
        await db?.drop();
      } finally {
        try {
          await valkey?.stop();
        } finally {
          await stopPostgresContainer();
        }
      }
    }
  }, 120_000);

  let held: Sale[];
  let withinTtl: Sale[];
  let afterExpiry: Sale[];
  let afterRefresh: Sale[];

  it('TC-RSK06-06 in-flight requests and requests inside the 60 s window keep the cached version 1; nobody fails', async () => {
    const warm = await flaggable('làm nóng cache');
    held = await sales('đang bay', 6);
    withinTtl = await sales('trong TTL', 4);
    afterExpiry = await sales('sau hết TTL', 4);
    afterRefresh = await sales('sau làm mới', 3);

    const parts = buildRiskConsumer(source, { redis, ai });
    await parts.consumer.handle(warm.event); // cold read: version 1 from PostgreSQL, latest written to Valkey
    expect(await cachedVersion()).toBe(1);
    const ttl = await admin.ttl(LATEST_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(LATEST_TTL_SECONDS);

    // Hold six requests inside feature extraction, i.e. after they have read the rule set.
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let reached = 0;
    const extract = parts.provider.extract.bind(parts.provider);
    jest.spyOn(parts.provider, 'extract').mockImplementation(async event => {
      reached++;
      await gate;
      return extract(event);
    });
    const inFlight = held.map(sale => parts.consumer.handle(sale.event));
    while (reached < held.length) await wait(10);

    // The configuration changes while Valkey still says "latest = 1": version 2 asks for external AI.
    await q(
      `INSERT INTO risk_rule_sets(version, config)
       SELECT max(version) + 1,
              (SELECT config FROM risk_rule_sets WHERE version = 1)
                || jsonb_build_object('mode', 'rules_with_external_ai', 'ai', $1::jsonb)
         FROM risk_rule_sets`,
      [JSON.stringify(VALID_AI)],
    );
    expect(await latestInPostgres()).toBe(2);
    release();
    await expect(Promise.all(inFlight)).resolves.toHaveLength(held.length);

    // Requests that start after the change but inside the window still get version 1 from the cache.
    expect(await cachedVersion()).toBe(1);
    await expect(
      Promise.all(withinTtl.map(sale => parts.consumer.handle(sale.event))),
    ).resolves.toHaveLength(withinTtl.length);

    expect(aiCalls).not.toHaveBeenCalled();
    expect(await cachedVersion()).toBe(1); // reading did not refresh the marker early
    await expectDecided([...held, ...withinTtl], 'rule_only', 1);
  });

  it('TC-RSK06-07 once the cached latest expires, the next request uses version 2 and rewrites the marker', async () => {
    expect(await latestInPostgres()).toBe(2);
    expect(await cachedVersion()).toBe(1);
    // "60 seconds later": the real key runs out (Valkey drops it after the shortened TTL).
    await admin.pExpire(LATEST_KEY, 1);
    await wait(50);
    expect(await cachedVersion()).toBeUndefined();

    const parts = buildRiskConsumer(source, { redis, ai });
    await expect(
      Promise.all(afterExpiry.map(sale => parts.consumer.handle(sale.event))),
    ).resolves.toHaveLength(afterExpiry.length);

    expect(aiCalls).toHaveBeenCalledTimes(afterExpiry.length);
    expect(await cachedVersion()).toBe(2);
    expect(await admin.ttl(LATEST_KEY)).toBeLessThanOrEqual(LATEST_TTL_SECONDS);
    await expectDecided(afterExpiry, 'rules_with_external_ai', 2);
  });

  it('TC-RSK06-08 when the cache is refreshed (marker removed) version 3 is used at once, without waiting for the TTL', async () => {
    // Version 3 puts the mode back to rule_only; the marker still says 2 with most of its minute left.
    await q(
      `INSERT INTO risk_rule_sets(version, config)
       SELECT max(version) + 1, (SELECT config FROM risk_rule_sets WHERE version = 1)
         FROM risk_rule_sets`,
    );
    expect(await latestInPostgres()).toBe(3);
    expect(await cachedVersion()).toBe(2);
    expect(await admin.ttl(LATEST_KEY)).toBeGreaterThan(0);

    const parts = buildRiskConsumer(source, { redis, ai });
    const calls = aiCalls.mock.calls.length;
    await parts.consumer.handle(afterRefresh[0].event);
    expect(await decisionsOf(afterRefresh[0].transferId)).toEqual([
      { mode: 'rules_with_external_ai', rule_set_version: 2 }, // still the cached version
    ]);

    // The cache is refreshed (a publisher or an operator drops the marker): the very next read wins.
    await admin.del(LATEST_KEY);
    await expect(
      Promise.all(afterRefresh.slice(1).map(sale => parts.consumer.handle(sale.event))),
    ).resolves.toHaveLength(afterRefresh.length - 1);
    expect(await cachedVersion()).toBe(3);
    expect(aiCalls.mock.calls.length).toBe(calls + 1); // only the first request went to AI
    await expectDecided(afterRefresh.slice(1), 'rule_only', 3);
    expect(await flagsOf(afterRefresh[0].transferId)).toBe(1);
    expect(await auditsOf(afterRefresh[0].transferId)).toBe(1);
  });
});
