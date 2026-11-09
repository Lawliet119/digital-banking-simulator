import { RedisUnavailableError } from '@libs/redis';
import { RiskMetrics } from '../risk.metrics';
import { OnlineFeatureProvider } from './online-feature-provider';
import type { TransferEvent } from './feature-provider';
import type { TransferFacts } from './transfer-facts';
import type { CounterRedis } from './window-counter';

const TRANSFER_SAMPLE: TransferEvent = {
  eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
  eventType: 'TransferCompleted',
  occurredAt: '2026-10-19T03:15:42.123Z',
  correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
  transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
  type: 'TRANSFER',
  fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
  toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  amount: '500000',
  fromBalanceBefore: '520000',
  fromAccountCreatedAt: '2026-09-30T08:00:00.000Z',
  toAccountCreatedAt: '2026-01-15T08:00:00.000Z',
  sameOwner: false,
  fromUserId: 'b2e5c8a1-6f40-4d93-8c17-a9d3f0e6b724',
  toUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const OCC = Date.parse('2026-10-19T03:15:42.123Z');

/** In-memory Redis with the five commands the counters use, and a switch that makes it fail. */
class FakeRedis implements CounterRedis {
  down = false;
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, Map<string, number>>();
  private guard(): void {
    if (this.down) throw new RedisUnavailableError('UNAVAILABLE');
  }
  get = (key: string): Promise<string | null> => {
    this.guard();
    return Promise.resolve(this.strings.get(key) ?? null);
  };
  set = (key: string, value: string): Promise<string> => {
    this.guard();
    this.strings.set(key, value);
    return Promise.resolve('OK');
  };
  incr = (key: string): Promise<string> => {
    this.guard();
    const next = String(Number(this.strings.get(key) ?? '0') + 1);
    this.strings.set(key, next);
    return Promise.resolve(next);
  };
  zadd = (key: string, score: number, member: string): Promise<number> => {
    this.guard();
    const set = this.sets.get(key) ?? new Map<string, number>();
    this.sets.set(key, set);
    set.set(member, score);
    return Promise.resolve(1);
  };
  zrangebyscore = (key: string, min: number, max: number): Promise<string[]> => {
    this.guard();
    return Promise.resolve(
      [...(this.sets.get(key) ?? new Map<string, number>())]
        .filter(([, score]) => score >= min && score <= max)
        .map(([member]) => member),
    );
  };
}

const eventAt = (id: string, deltaMs: number, to = 'to-1'): TransferEvent => ({
  ...TRANSFER_SAMPLE,
  transferId: id,
  toAccountId: to,
  occurredAt: new Date(OCC + deltaMs).toISOString(),
});

describe('DBS-109 OnlineFeatureProvider (orchestration)', () => {
  let redis: FakeRedis;
  let metrics: RiskMetrics;
  let committed: { id: string; atMs: number }[];
  let newRecipients: { recipientId: string; atMs: number }[];
  let isNew: boolean;
  let facts: jest.Mocked<TransferFacts>;
  let provider: OnlineFeatureProvider;

  beforeEach(() => {
    redis = new FakeRedis();
    metrics = new RiskMetrics();
    committed = [];
    newRecipients = [];
    isNew = true;
    facts = {
      windowTransfers: jest.fn((_account: string, occ: number, window: number) =>
        Promise.resolve(committed.filter(t => t.atMs > occ - window && t.atMs <= occ)),
      ),
      newRecipientsInWindow: jest.fn(() => Promise.resolve(newRecipients)),
      isNewRecipient: jest.fn(() => Promise.resolve(isNew)),
      history: jest.fn(() => Promise.resolve({ count: 6, median2: '1000000' })),
      reverseTransfer: jest.fn(() => Promise.resolve(null)),
      outflow24h: jest.fn(() => Promise.resolve({ distinctRecipients: 2, sum: '900', small: 1 })),
    } as unknown as jest.Mocked<TransferFacts>;
    provider = new OnlineFeatureProvider({ facts, redis, perTxLimit: 500_000n, metrics });
  });

  const commit = (id: string, deltaMs: number) => committed.push({ id, atMs: OCC + deltaMs });

  it('TC-109-01 the SQL-backed fields come straight from the queries', async () => {
    commit('t1', 0);
    const features = await provider.extract(eventAt('t1', 0));
    expect(features).toMatchObject({
      historyCount30d: 6,
      medianAmount30dTimes2: '1000000',
      reverseTransferOccurredAt: null,
      distinctRecipients24h: 2,
      sumOut24h: '900',
      smallTxCount24h: 1,
    });
    expect(facts.outflow24h).toHaveBeenCalledWith(TRANSFER_SAMPLE.fromAccountId, OCC, 500_000n);
  });

  it('TC-109-01 under five past transfers there is no median', async () => {
    commit('t1', 0);
    facts.history.mockResolvedValue({ count: 4, median2: '10' });
    expect((await provider.extract(eventAt('t1', 0))).medianAmount30dTimes2).toBeNull();
  });

  it('TC-109-01 a cold counter is loaded from SQL once, then answers without SQL', async () => {
    commit('t1', -20 * MIN);
    commit('t2', -2 * MIN);
    commit('t3', 0);
    const first = await provider.extract(eventAt('t3', 0));
    expect([first.txCount10m, first.txCount1h]).toEqual([2, 3]);
    expect(facts.windowTransfers).toHaveBeenCalledTimes(1);
    expect(await metrics.count('R1', 'cold')).toBe(1);

    commit('t4', MIN);
    const second = await provider.extract(eventAt('t4', MIN));
    expect([second.txCount10m, second.txCount1h]).toEqual([3, 4]);
    expect(facts.windowTransfers).toHaveBeenCalledTimes(1); // answered by Redis
  });

  it('TC-109-01 the same transferId twice is counted once', async () => {
    commit('t1', 0);
    await provider.extract(eventAt('t1', 0));
    commit('t2', MIN);
    const once = await provider.extract(eventAt('t2', MIN));
    const twice = await provider.extract(eventAt('t2', MIN));
    expect(twice.txCount1h).toBe(once.txCount1h);
    expect(once.txCount1h).toBe(2);
  });

  it('TC-109-01 a late event whose window starts before the covered range goes to SQL', async () => {
    commit('t0', -30 * MIN);
    commit('t1', 0);
    await provider.extract(eventAt('t1', 0)); // loads the set, covered from OCC - 1h + 1
    facts.windowTransfers.mockClear();
    commit('t-1', -2 * HOUR);
    const late = await provider.extract(eventAt('t-1', -2 * HOUR));
    expect(facts.windowTransfers).toHaveBeenCalledTimes(1);
    expect(late.txCount1h).toBe(1);
  });

  it('TC-109-01 the current transfer counts even when SQL does not list it yet', async () => {
    const features = await provider.extract(eventAt('t1', 0));
    expect(features.txCount10m).toBe(1);
  });

  it('TC-109-07 Redis down: the answer comes from SQL and the fallback is counted', async () => {
    commit('t1', -MIN);
    commit('t2', 0);
    redis.down = true;
    const features = await provider.extract(eventAt('t2', 0));
    expect([features.txCount10m, features.txCount1h]).toEqual([2, 2]);
    expect(await metrics.count('R1', 'error')).toBeGreaterThanOrEqual(1);
    expect(await metrics.count('R5', 'error')).toBeGreaterThanOrEqual(1);
  });

  it('TC-109-07 after an outage the sets are not trusted until they are loaded again from SQL', async () => {
    commit('t1', -5 * MIN);
    commit('t2', 0);
    await provider.extract(eventAt('t2', 0)); // warm
    redis.down = true;
    commit('t3', MIN); // processed during the outage: never written to Redis
    await provider.extract(eventAt('t3', MIN));
    redis.down = false;
    facts.windowTransfers.mockClear();
    commit('t4', 2 * MIN);
    const after = await provider.extract(eventAt('t4', 2 * MIN));
    expect(after.txCount1h).toBe(4); // t1, t2, t3, t4: t3 is back thanks to the reload
    expect(facts.windowTransfers).toHaveBeenCalledTimes(1);
    expect(redis.strings.get('risk:gen')).toBe('1');
  });

  it('TC-109-04 R5 warm: only a new recipient is added, and members are distinct', async () => {
    newRecipients = [{ recipientId: 'r1', atMs: OCC - 30 * MIN }];
    const first = await provider.extract(eventAt('t1', 0, 'r1'));
    expect(first.newRecipients1h).toBe(1); // loaded from SQL
    isNew = true;
    const second = await provider.extract(eventAt('t2', MIN, 'r2'));
    expect(second.newRecipients1h).toBe(2);
    isNew = false; // r2 again: no longer new
    const third = await provider.extract(eventAt('t3', 2 * MIN, 'r2'));
    expect(third.newRecipients1h).toBe(2);
    expect(facts.newRecipientsInWindow).toHaveBeenCalledTimes(1);
  });

  it('TC-109-04 a SQL error is not hidden as a Redis fallback', async () => {
    commit('t1', 0);
    facts.history.mockRejectedValue(new Error('database unavailable'));
    await expect(provider.extract(eventAt('t1', 0))).rejects.toThrow('database unavailable');
  });
  it('TC-111-12 after invalidateCounters the first extract raises risk:gen before trusting any set', async () => {
    commit('t1', 0);
    await provider.extract(eventAt('t1', 0)); // warms the R1 and R5 sets at the current generation
    const gen = redis.strings.get('risk:gen') ?? null;
    const calls: string[] = [];
    const incr = redis.incr;
    const zadd = redis.zadd;
    redis.incr = (key: string) => {
      calls.push(`incr ${key}`);
      return incr(key);
    };
    redis.zadd = (key: string, score: number, member: string) => {
      calls.push('zadd');
      return zadd(key, score, member);
    };
    provider.invalidateCounters();
    commit('t2', MIN);
    await provider.extract(eventAt('t2', MIN));
    expect(calls[0]).toBe('incr risk:gen');
    expect(redis.strings.get('risk:gen')).not.toBe(gen);
    // The old coverage is retired, so R1 is answered from SQL again.
    expect(facts.windowTransfers).toHaveBeenCalledTimes(2);
  });
});
