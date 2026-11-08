import type { RedisClient } from '@libs/redis';
import type { RiskMetrics } from '../risk.metrics';
import { InvalidRuleSetError, parseRuleSet, type RuleSet } from './rule-set';

/** Which version is current. Short, so a new version reaches every worker within a minute. */
export const LATEST_KEY = 'cfg:risk:latest';
export const LATEST_TTL_SECONDS = 60;
/** What a version says never changes, so it stays long (the largest TTL `RedisClient` accepts). */
const CONTENT_TTL_SECONDS = 604_800;

export const versionKey = (version: number): string => `cfg:risk:v${version}`;

export type RuleSetRedis = Pick<RedisClient, 'get' | 'set'>;

export interface RuleSetDb {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface RuleSetRepositoryDeps {
  readonly redis: RuleSetRedis;
  readonly db: RuleSetDb;
  readonly metrics: RiskMetrics;
}

interface Row {
  readonly version: number;
  readonly config: unknown;
}

const VERSION_NUMBER = /^[1-9]\d{0,9}$/;

/**
 * The rule configuration a worker scores with (UC-12, guide §4.6). Versions are immutable rows of
 * `risk_rule_sets`. Redis only caches them:
 *
 * - `cfg:risk:latest` (TTL 60 s) names the current version, so a new version is in use everywhere
 *   at most 60 s after it is written;
 * - `cfg:risk:v{n}` (TTL 7 days) holds that version's JSON.
 *
 * A miss, a corrupt value or any Redis failure reads PostgreSQL instead: the configuration is
 * exact whether Redis is up, slow or gone. Call it before the consumer's transaction opens.
 */
export class RuleSetRepository {
  private readonly redis: RuleSetRedis;
  private readonly db: RuleSetDb;
  private readonly metrics: RiskMetrics;
  /** Parsed versions, by number: a version cannot change, so parsing it once is enough. */
  private readonly parsed = new Map<number, RuleSet>();

  constructor(deps: RuleSetRepositoryDeps) {
    this.redis = deps.redis;
    this.db = deps.db;
    this.metrics = deps.metrics;
  }

  /** The current rule set. Throws `InvalidRuleSetError` when the stored version is unusable. */
  async current(): Promise<RuleSet> {
    const cachedVersion = await this.cachedLatest();
    if (cachedVersion !== undefined) {
      const cached = await this.cachedContent(cachedVersion);
      if (cached) return cached;
      const row = await this.rowByVersion(cachedVersion);
      if (row) return this.useRow(row);
    }
    const [row] = (await this.db.query(
      'SELECT version, config FROM risk_rule_sets ORDER BY version DESC LIMIT 1',
    )) as Row[];
    if (!row) throw new InvalidRuleSetError('no version stored');
    const set = this.parse(row);
    await this.remember(row, true);
    return set;
  }

  private parse(row: Row): RuleSet {
    const known = this.parsed.get(row.version);
    if (known) return known;
    const set = parseRuleSet(Number(row.version), row.config);
    if (this.parsed.size >= 32) this.parsed.clear();
    this.parsed.set(set.version, set);
    return set;
  }

  private async useRow(row: Row): Promise<RuleSet> {
    const set = this.parse(row);
    await this.remember(row, false);
    return set;
  }

  private async rowByVersion(version: number): Promise<Row | undefined> {
    const [row] = (await this.db.query(
      'SELECT version, config FROM risk_rule_sets WHERE version = $1',
      [version],
    )) as Row[];
    return row;
  }

  private async cachedLatest(): Promise<number | undefined> {
    try {
      const value = await this.redis.get(LATEST_KEY);
      return value !== null && VERSION_NUMBER.test(value) ? Number(value) : undefined;
    } catch {
      this.metrics.configFallback();
      return undefined;
    }
  }

  private async cachedContent(version: number): Promise<RuleSet | undefined> {
    const known = this.parsed.get(version);
    if (known) return known; // immutable: no need to read it again
    try {
      const text = await this.redis.get(versionKey(version));
      if (text === null) return undefined;
      return this.parse({ version, config: JSON.parse(text) as unknown });
    } catch {
      // Redis down, or the cached text is not a usable version: PostgreSQL decides.
      this.metrics.configFallback();
      return undefined;
    }
  }

  /** Best effort: a cache that cannot be written is only a slower next read. */
  private async remember(row: Row, alsoLatest: boolean): Promise<void> {
    try {
      await this.redis.set(
        versionKey(row.version),
        JSON.stringify(row.config),
        CONTENT_TTL_SECONDS,
      );
      if (alsoLatest) await this.redis.set(LATEST_KEY, String(row.version), LATEST_TTL_SECONDS);
    } catch {
      this.metrics.configFallback();
    }
  }
}
