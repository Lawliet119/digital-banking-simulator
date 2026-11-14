import { RedisUnavailableError } from '@libs/redis';
import { RiskMetrics } from '../risk.metrics';
import { InvalidRuleSetError } from './rule-set';
import { RuleSetRepository } from './rule-set.repository';

const config = (weight: number, mode = 'rule_only') => ({
  mode,
  thresholds: { medium: 40, high: 70 },
  rules: {
    R1: { enabled: true, weight, maxTransfers: 5, windowMinutes: 10 },
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
  },
});

const unavailable = () => Promise.reject(new RedisUnavailableError('UNAVAILABLE'));
const noCache = {
  get: unavailable,
  readExpiringVersion: unavailable,
  serverTimeMs: unavailable,
  setIfAbsent: unavailable,
  setVersionBefore: unavailable,
};

describe('DBS-110 RuleSetRepository failure and freshness behavior', () => {
  it('uses the latest PostgreSQL version when Redis is unavailable', async () => {
    let rows = [{ version: 1, config: config(30) }];
    const repository = new RuleSetRepository({
      redis: noCache,
      db: { query: () => Promise.resolve(rows) },
      metrics: new RiskMetrics(),
    });
    expect((await repository.current()).version).toBe(1);
    rows = [{ version: 2, config: config(50) }];
    expect((await repository.current()).rules.R1.weight).toBe(50);
  });

  it('does not silently substitute a rule set when the database is empty or invalid', async () => {
    let rows: { version: number; config: unknown }[] = [];
    const repository = new RuleSetRepository({
      redis: noCache,
      db: { query: () => Promise.resolve(rows) },
      metrics: new RiskMetrics(),
    });
    await expect(repository.current()).rejects.toBeInstanceOf(InvalidRuleSetError);
    rows = [{ version: 1, config: { mode: 'rule_only', rules: {} } }];
    await expect(repository.current()).rejects.toBeInstanceOf(InvalidRuleSetError);
  });

  it('propagates a database failure when no valid cache exists', async () => {
    const repository = new RuleSetRepository({
      redis: noCache,
      db: { query: () => Promise.reject(new Error('connection lost')) },
      metrics: new RiskMetrics(),
    });
    await expect(repository.current()).rejects.toThrow('connection lost');
  });

  it('rejects snapshots when SQL takes at least the entire freshness budget', async () => {
    const metrics = new RiskMetrics();
    let elapsed = 0;
    const clock = { monotonicMs: () => elapsed, wallMs: () => elapsed };
    const repository = new RuleSetRepository({
      redis: noCache,
      db: {
        query: () => {
          elapsed += 60_000;
          return Promise.resolve([{ version: 1, config: config(30) }]);
        },
      },
      metrics,
      clock,
    });
    await expect(repository.current()).rejects.toThrow('freshness');
    // BL-188: each discarded selection is counted (both attempts), the signal of the freshness alarm.
    expect(await metrics.configFreshnessExceededCount()).toBe(2);
  });

  it('retries a stale SQL snapshot and selects the newer version', async () => {
    const metrics = new RiskMetrics();
    let elapsed = 0;
    let first = true;
    const clock = { monotonicMs: () => elapsed, wallMs: () => elapsed };
    const repository = new RuleSetRepository({
      redis: noCache,
      db: {
        query: () => {
          if (first) {
            first = false;
            elapsed += 60_000;
            return Promise.resolve([{ version: 1, config: config(30) }]);
          }
          return Promise.resolve([{ version: 2, config: config(50) }]);
        },
      },
      metrics,
      clock,
    });
    expect((await repository.current()).version).toBe(2);
    expect(await metrics.configFreshnessExceededCount()).toBe(1); // the discarded stale snapshot
  });

  it('fails closed if the local monotonic clock moves backward during selection', async () => {
    const metrics = new RiskMetrics();
    let monotonic = 0;
    const clock = { monotonicMs: () => --monotonic, wallMs: () => 0 };
    const repository = new RuleSetRepository({
      redis: noCache,
      db: { query: () => Promise.resolve([{ version: 1, config: config(30) }]) },
      metrics,
      clock,
    });
    await expect(repository.current()).rejects.toThrow('freshness');
    expect(await metrics.configFreshnessExceededCount()).toBe(2); // a clock that went backwards is the same event
  });

  it('does not use a cached version after a delayed Redis time sample', async () => {
    let elapsed = 0;
    let first = true;
    const clock = { monotonicMs: () => elapsed, wallMs: () => elapsed };
    const redis = {
      readExpiringVersion: () => Promise.resolve({ version: 1, deadlineMs: 1010 }),
      get: () => Promise.resolve(JSON.stringify(config(30))),
      serverTimeMs: () => {
        if (first) {
          elapsed += 20;
          first = false;
        }
        return Promise.resolve(1000);
      },
      setIfAbsent: () => Promise.resolve(false),
      setVersionBefore: () => Promise.resolve(false),
    };
    const repository = new RuleSetRepository({
      redis,
      db: { query: () => Promise.resolve([{ version: 2, config: config(50) }]) },
      metrics: new RiskMetrics(),
      clock,
    });
    expect((await repository.current()).version).toBe(2);
  });
});

describe('BL-208 RuleSetRepository trusts only PostgreSQL for content', () => {
  const marker = (version: number) => ({
    readExpiringVersion: () => Promise.resolve({ version, deadlineMs: Date.now() + 30_000 }),
    serverTimeMs: () => Promise.resolve(Date.now()),
    setVersionBefore: () => Promise.resolve(true),
  });

  it('never reads cfg:risk:v{n}: a valid entry that differs from PostgreSQL is ignored', async () => {
    const get = jest.fn(() => Promise.resolve(JSON.stringify(config(99))));
    const sql: string[] = [];
    const repository = new RuleSetRepository({
      redis: { ...marker(1), get, setIfAbsent: unavailable } as never,
      db: {
        query: (text: string) => {
          sql.push(text);
          return Promise.resolve([{ version: 1, config: config(30) }]);
        },
      },
      metrics: new RiskMetrics(),
    });
    expect((await repository.current()).rules.R1.weight).toBe(30);
    expect(get).not.toHaveBeenCalled();
    expect(sql).toHaveLength(1);
    // The parsed version stays in memory: the next read does not touch PostgreSQL again.
    expect((await repository.current()).rules.R1.weight).toBe(30);
    expect(sql).toHaveLength(1);
  });

  it('a marker above int4 never reaches WHERE version = $1 and is counted as corrupt', async () => {
    const calls: unknown[][] = [];
    const metrics = new RiskMetrics();
    const repository = new RuleSetRepository({
      redis: marker(9_999_999_999),
      db: {
        query: (text: string, params?: unknown[]) => {
          calls.push([text, params]);
          return Promise.resolve([{ version: 2, config: config(30) }]);
        },
      },
      metrics,
    });
    expect((await repository.current()).version).toBe(2);
    expect(calls.every(([, params]) => params === undefined)).toBe(true);
    expect(await metrics.configFallbackCount('corrupt')).toBe(1);
    expect(await metrics.configFallbackCount('error')).toBe(0);
  });

  it('a marker naming a version PostgreSQL does not have is corrupt and falls back to the latest', async () => {
    const metrics = new RiskMetrics();
    const repository = new RuleSetRepository({
      redis: marker(7),
      db: {
        query: (_text: string, params?: unknown[]) =>
          Promise.resolve(params ? [] : [{ version: 2, config: config(30) }]),
      },
      metrics,
    });
    expect((await repository.current()).version).toBe(2);
    expect(await metrics.configFallbackCount('corrupt')).toBe(1);
  });

  it('labels the fallback by cause: a Redis failure is error, unusable content is corrupt', async () => {
    const metrics = new RiskMetrics();
    const rows = [{ version: 1, config: config(30) }];
    for (const reason of ['UNAVAILABLE', 'CORRUPT'] as const) {
      await new RuleSetRepository({
        redis: {
          ...noCache,
          readExpiringVersion: () => Promise.reject(new RedisUnavailableError(reason)),
        },
        db: { query: () => Promise.resolve(rows) },
        metrics,
      }).current();
    }
    // The UNAVAILABLE read, and the two failed Redis time reads of the PostgreSQL path.
    expect(await metrics.configFallbackCount('error')).toBe(3);
    expect(await metrics.configFallbackCount('corrupt')).toBe(1);
  });
});
