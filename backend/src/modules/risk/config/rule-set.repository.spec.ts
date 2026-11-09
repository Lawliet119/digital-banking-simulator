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
      metrics: new RiskMetrics(),
      clock,
    });
    await expect(repository.current()).rejects.toThrow('freshness');
  });

  it('retries a stale SQL snapshot and selects the newer version', async () => {
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
      metrics: new RiskMetrics(),
      clock,
    });
    expect((await repository.current()).version).toBe(2);
  });

  it('fails closed if the local monotonic clock moves backward during selection', async () => {
    let monotonic = 0;
    const clock = { monotonicMs: () => --monotonic, wallMs: () => 0 };
    const repository = new RuleSetRepository({
      redis: noCache,
      db: { query: () => Promise.resolve([{ version: 1, config: config(30) }]) },
      metrics: new RiskMetrics(),
      clock,
    });
    await expect(repository.current()).rejects.toThrow('freshness');
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
