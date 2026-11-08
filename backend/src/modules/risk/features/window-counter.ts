import type { RedisClient } from '@libs/redis';

/** The part of `RedisClient` the counters use; tests pass an in-memory double. */
export type CounterRedis = Pick<RedisClient, 'get' | 'set' | 'zadd' | 'zrangebyscore' | 'incr'>;

/** Key of the generation number shared by every counter and every worker. */
export const GEN_KEY = 'risk:gen';
/** How long a counter outlives its last write (FRAUD_DETECTION_GUIDE §5.4). */
export const COUNTER_TTL_SECONDS = 7200;
/** The coverage mark expires first, so a mark never outlives the members it vouches for. */
const MARK_TTL_SECONDS = COUNTER_TTL_SECONDS - 300;
const GEN_TTL_SECONDS = 604_800;

export interface Entry {
  readonly member: string;
  readonly atMs: number;
}

/**
 * A Redis sorted set that caches "who did something, and when" for one account (R1: transfers;
 * R5: new recipients). **SQL is the source of truth; this is only a cache that must prove it is
 * complete before anyone trusts it** (guide §5.4: a cold cache is not zero).
 *
 * - `key = <prefix>:<accountId>`: members with score = event time in ms. The same member twice is
 *   one member, so a redelivered event is not counted twice.
 * - `<key>:cov = "<gen>:<coveredFromMs>"`: the set holds every entry with time >= `coveredFromMs`,
 *   written when the set was loaded from SQL. It is valid only while `gen` equals `risk:gen`, which
 *   a worker raises after Redis was down (events answered from SQL during the outage were not
 *   written here), and only for windows that start at or after `coveredFromMs`.
 * - Nothing is trimmed by event time (a late event would lose what it needs); the sets only expire.
 */
export class WindowCounter {
  constructor(
    private readonly redis: CounterRedis,
    private readonly prefix: string,
    private readonly seedLimit = 500,
  ) {}

  private key(accountId: string): string {
    return `${this.prefix}:${accountId}`;
  }

  /** Raise the generation: every coverage mark written before now stops being valid. */
  async bumpGeneration(): Promise<void> {
    await this.redis.incr(GEN_KEY, GEN_TTL_SECONDS);
  }

  /**
   * Reads the generation and the coverage mark. `covered` is true when the set can answer a
   * window starting at `windowFromMs`; `gen` is returned either way and must be passed to `seed`,
   * which has to read SQL *after* this call.
   */
  async lookup(
    accountId: string,
    windowFromMs: number,
  ): Promise<{ gen: string; covered: boolean }> {
    const gen = (await this.redis.get(GEN_KEY)) ?? '0';
    const mark = await this.redis.get(`${this.key(accountId)}:cov`);
    if (mark === null) return { gen, covered: false };
    const [markGen, from] = mark.split(':');
    return { gen, covered: markGen === gen && windowFromMs >= Number(from) };
  }

  async add(accountId: string, member: string, atMs: number): Promise<void> {
    await this.redis.zadd(this.key(accountId), atMs, member, COUNTER_TTL_SECONDS);
  }

  /** Distinct members with time in `[fromMs, toMs]`. */
  async count(accountId: string, fromMs: number, toMs: number): Promise<number> {
    return (await this.redis.zrangebyscore(this.key(accountId), fromMs, toMs)).length;
  }

  /**
   * Loads the set from SQL rows and marks it as complete from `coveredFromMs`. Skipped (the account
   * is simply always answered by SQL) when there are more rows than `seedLimit`.
   */
  async seed(
    accountId: string,
    gen: string,
    entries: readonly Entry[],
    coveredFromMs: number,
  ): Promise<void> {
    if (entries.length > this.seedLimit) return;
    for (const entry of entries) await this.add(accountId, entry.member, entry.atMs);
    await this.redis.set(`${this.key(accountId)}:cov`, `${gen}:${coveredFromMs}`, MARK_TTL_SECONDS);
  }
}
