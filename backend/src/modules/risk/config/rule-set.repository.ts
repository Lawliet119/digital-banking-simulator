import { performance } from 'node:perf_hooks';
import { RedisUnavailableError, type RedisClient } from '@libs/redis';
import type { ConfigFallbackReason, RiskMetrics } from '../risk.metrics';
import { InvalidRuleSetError, parseRuleSet, type RuleSet } from './rule-set';

/** The current version has a strict 60-second freshness budget. */
export const LATEST_KEY = 'cfg:risk:latest:v2';
export const LATEST_TTL_SECONDS = 60;
const MAX_AGE_MS = LATEST_TTL_SECONDS * 1000;
const MAX_CACHE_TIME_MS = 253_402_300_799_999;
const MAX_VERSION = 2_147_483_647; // PostgreSQL int4: `risk_rule_sets.version`

/**
 * Redis only says which version is current (and for how long). Rule-set content is never read from
 * Redis: it comes from PostgreSQL rows only, so whoever can write to Redis cannot change scoring.
 */
export type RuleSetRedis = Pick<
  RedisClient,
  'serverTimeMs' | 'readExpiringVersion' | 'setVersionBefore'
>;

const redisReason = (error: unknown): ConfigFallbackReason | undefined =>
  error instanceof RedisUnavailableError
    ? error.reason === 'CORRUPT'
      ? 'corrupt'
      : 'error'
    : undefined;

export interface RuleSetDb {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

interface RuleSetClock {
  monotonicMs(): number;
  wallMs(): number;
}

export interface RuleSetRepositoryDeps {
  readonly redis: RuleSetRedis;
  readonly db: RuleSetDb;
  readonly metrics: RiskMetrics;
  readonly clock?: RuleSetClock;
}

interface Row {
  readonly version: number;
  readonly config: unknown;
}

const systemClock: RuleSetClock = {
  monotonicMs: () => performance.now(),
  wallMs: () => Date.now(),
};
class FreshnessExpired extends Error {}

/** Reads immutable rule sets outside the consumer transaction; PostgreSQL is authoritative. */
export class RuleSetRepository {
  private readonly redis: RuleSetRedis;
  private readonly db: RuleSetDb;
  private readonly metrics: RiskMetrics;
  private readonly clock: RuleSetClock;
  /** Parsed versions, by number: a version cannot change, so parsing it once is enough. */
  private readonly parsed = new Map<number, RuleSet>();

  constructor(deps: RuleSetRepositoryDeps) {
    this.redis = deps.redis;
    this.db = deps.db;
    this.metrics = deps.metrics;
    this.clock = deps.clock ?? systemClock;
  }

  private stamp(): readonly [number, number] {
    return [this.clock.monotonicMs(), this.clock.wallMs()];
  }

  private elapsed(start: readonly [number, number]): number {
    const mono = this.clock.monotonicMs() - start[0];
    const wall = this.clock.wallMs() - start[1];
    if (!Number.isFinite(mono) || !Number.isFinite(wall) || mono < 0 || wall < 0) return Infinity;
    // Redis TIME is truncated to milliseconds; reserve one millisecond for rounding.
    return Math.ceil(Math.max(mono, wall)) + 1;
  }

  /** The current rule set, selected before its cache or SQL freshness deadline. */
  async current(): Promise<RuleSet> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cached = await this.selectCached();
      if (cached) return cached;
      try {
        return await this.selectFromDatabase();
      } catch (error) {
        if (!(error instanceof FreshnessExpired)) throw error;
      }
    }
    throw new Error('Risk rule set freshness bound exceeded');
  }

  private parse(row: Row): RuleSet {
    const known = this.parsed.get(row.version);
    if (known) return known;
    const set = parseRuleSet(Number(row.version), row.config);
    if (this.parsed.size >= 32) this.parsed.clear();
    this.parsed.set(set.version, set);
    return set;
  }

  private async selectCached(): Promise<RuleSet | undefined> {
    try {
      const marker = await this.redis.readExpiringVersion(LATEST_KEY);
      if (!marker) return undefined;
      // The marker is a number from Redis: it must be a valid int4 before it becomes a SQL
      // parameter, or PostgreSQL's range error would fail every event until the key expires.
      if (
        !Number.isSafeInteger(marker.version) ||
        marker.version < 1 ||
        marker.version > MAX_VERSION
      ) {
        this.metrics.configFallback('corrupt');
        return undefined;
      }
      let set = this.parsed.get(marker.version);
      if (!set) {
        const [row] = (await this.db.query(
          'SELECT version, config FROM risk_rule_sets WHERE version = $1',
          [marker.version],
        )) as Row[];
        if (!row) {
          this.metrics.configFallback('corrupt'); // the marker names a version PostgreSQL lacks
          return undefined;
        }
        set = this.parse(row);
      }
      const start = this.stamp();
      const serverTime = await this.redis.serverTimeMs();
      return serverTime + this.elapsed(start) < marker.deadlineMs ? set : undefined;
    } catch (error) {
      // Only a Redis failure is a Redis fallback; a PostgreSQL or parse error is not counted here
      // and the PostgreSQL path below reports it by itself.
      const reason = redisReason(error);
      if (reason) this.metrics.configFallback(reason);
      return undefined;
    }
  }

  private async selectFromDatabase(): Promise<RuleSet> {
    let serverTime: number | undefined;
    try {
      serverTime = await this.redis.serverTimeMs();
    } catch (error) {
      this.metrics.configFallback(redisReason(error) ?? 'error');
    }
    const start = this.stamp();
    const [row] = (await this.db.query(
      'SELECT version, config FROM risk_rule_sets ORDER BY version DESC LIMIT 1',
    )) as Row[];
    if (!row) throw new InvalidRuleSetError('no version stored');
    const set = this.parse(row);
    if (this.elapsed(start) >= MAX_AGE_MS) throw new FreshnessExpired();
    if (serverTime !== undefined && serverTime <= MAX_CACHE_TIME_MS - MAX_AGE_MS) {
      try {
        // Forward-only in Redis (Lua compare-and-set): a late reader cannot move `latest` back or
        // push its deadline past the one the version it read was entitled to.
        await this.redis.setVersionBefore(LATEST_KEY, row.version, serverTime + MAX_AGE_MS);
      } catch (error) {
        this.metrics.configFallback(redisReason(error) ?? 'error');
      }
    }
    if (this.elapsed(start) >= MAX_AGE_MS) throw new FreshnessExpired();
    return set;
  }
}
