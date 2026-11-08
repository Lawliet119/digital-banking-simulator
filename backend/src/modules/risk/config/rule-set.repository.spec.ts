import { RedisUnavailableError } from '@libs/redis';
import { RiskMetrics } from '../risk.metrics';
import { InvalidRuleSetError } from './rule-set';
import {
  LATEST_KEY,
  LATEST_TTL_SECONDS,
  RuleSetRepository,
  versionKey,
} from './rule-set.repository';

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

class FakeRedis {
  down = false;
  gets = 0;
  readonly store = new Map<string, { value: string; ttl: number }>();
  get = (key: string): Promise<string | null> => {
    this.gets++;
    if (this.down) return Promise.reject(new RedisUnavailableError('UNAVAILABLE'));
    return Promise.resolve(this.store.get(key)?.value ?? null);
  };
  set = (key: string, value: string, ttl: number): Promise<string> => {
    if (this.down) return Promise.reject(new RedisUnavailableError('UNAVAILABLE'));
    this.store.set(key, { value, ttl });
    return Promise.resolve('OK');
  };
}

describe('DBS-110 RuleSetRepository (orchestration)', () => {
  let redis: FakeRedis;
  let rows: { version: number; config: unknown }[];
  let reads: string[];
  let metrics: RiskMetrics;
  let repository: RuleSetRepository;
  let make: () => RuleSetRepository;

  beforeEach(() => {
    redis = new FakeRedis();
    rows = [{ version: 1, config: config(30) }];
    reads = [];
    metrics = new RiskMetrics();
    const db = {
      query: (sql: string, params: unknown[] = []) => {
        reads.push(sql.includes('ORDER BY') ? 'latest' : `v${String(params[0])}`);
        const sorted = [...rows].sort((a, b) => b.version - a.version);
        return Promise.resolve(
          sql.includes('ORDER BY') ? sorted.slice(0, 1) : rows.filter(r => r.version === params[0]),
        );
      },
    };
    make = () => new RuleSetRepository({ redis, db, metrics });
    repository = make();
  });

  it('TC-110-01 a cold cache reads PostgreSQL once and stores latest (60 s) and the version content', async () => {
    const set = await repository.current();
    expect(set.version).toBe(1);
    expect(reads).toEqual(['latest']);
    expect(redis.store.get(LATEST_KEY)).toEqual({ value: '1', ttl: LATEST_TTL_SECONDS });
    expect(LATEST_TTL_SECONDS).toBe(60);
    const content = redis.store.get(versionKey(1));
    expect(JSON.parse(content!.value)).toEqual(rows[0].config);
    expect(content!.ttl).toBeGreaterThan(24 * 3600); // immutable: kept long
  });

  it('TC-110-01 a warm cache answers without PostgreSQL', async () => {
    await repository.current();
    reads.length = 0;
    const set = await repository.current();
    expect(set.version).toBe(1);
    expect(reads).toEqual([]);
  });

  it('TC-110-01 a new version is picked up once latest expires, not before', async () => {
    await repository.current();
    rows.push({ version: 2, config: config(50) });
    expect((await repository.current()).version).toBe(1); // still inside the 60 s
    redis.store.delete(LATEST_KEY); // the TTL ran out
    const next = await repository.current();
    expect(next.version).toBe(2);
    expect(next.rules.R1.weight).toBe(50);
    expect(redis.store.get(LATEST_KEY)?.value).toBe('2');
  });

  it('TC-110-01 latest known but its content missing: PostgreSQL by version, then cached', async () => {
    redis.store.set(LATEST_KEY, { value: '1', ttl: 60 });
    expect((await repository.current()).version).toBe(1);
    expect(reads).toEqual(['v1']);
    expect(redis.store.has(versionKey(1))).toBe(true);
  });

  it('TC-110-01 a corrupt cached version falls back to PostgreSQL', async () => {
    redis.store.set(LATEST_KEY, { value: '1', ttl: 60 });
    for (const junk of ['not json', '{"mode":"rule_only"}', 'null', '[]']) {
      redis.store.set(versionKey(1), { value: junk, ttl: 1000 });
      reads.length = 0;
      expect((await make().current()).version).toBe(1);
      expect(reads).toEqual(['v1']);
    }
  });

  it('TC-110-01 a latest value that is not a version number is ignored', async () => {
    for (const junk of ['abc', '0', '-3', '1.5', '99999999999', '']) {
      redis.store.set(LATEST_KEY, { value: junk, ttl: 60 });
      reads.length = 0;
      expect((await make().current()).version).toBe(1);
      expect(reads).toEqual(['latest']);
    }
  });

  it('TC-110-02 with Redis down every read comes from PostgreSQL and is exact', async () => {
    redis.down = true;
    expect((await repository.current()).version).toBe(1);
    rows.push({ version: 2, config: config(50) });
    expect((await repository.current()).version).toBe(2); // no 60 s wait without a cache
    expect(await metrics.configFallbackCount()).toBeGreaterThanOrEqual(2);
  });

  it('TC-110-02 Redis coming back is used again', async () => {
    redis.down = true;
    await repository.current();
    redis.down = false;
    await repository.current();
    reads.length = 0;
    await repository.current();
    expect(reads).toEqual([]);
  });

  it('TC-110-03 an unusable stored version is an error, not a silent default', async () => {
    rows = [{ version: 1, config: { mode: 'rule_only', rules: {} } }];
    await expect(repository.current()).rejects.toBeInstanceOf(InvalidRuleSetError);
  });

  it('TC-110-03 no version at all is an error', async () => {
    rows = [];
    await expect(repository.current()).rejects.toBeInstanceOf(InvalidRuleSetError);
  });

  it('TC-110-03 a PostgreSQL error is thrown as it is', async () => {
    const failing = new RuleSetRepository({
      redis,
      db: { query: () => Promise.reject(new Error('connection lost')) },
      metrics,
    });
    await expect(failing.current()).rejects.toThrow('connection lost');
  });

  it('TC-110-04 the version in the result is the one a flag has to record', async () => {
    rows.push({ version: 7, config: config(31, 'rules_with_external_ai') });
    const set = await repository.current();
    expect(set.version).toBe(7);
    expect(set.mode).toBe('rules_with_external_ai');
    expect(set.aiConfigInvalid).toBe(true); // no ai block in that version
  });
});
