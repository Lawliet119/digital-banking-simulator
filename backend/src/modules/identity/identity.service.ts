import { Injectable } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';

/** Most subs kept in the per-process cache. A constant, not an env var: it only bounds memory. */
const USER_ID_CACHE_MAX = 10_000;

// Two statements, never one CTE: a CTE's SELECT shares the INSERT's snapshot, so it can miss a
// row a parallel request committed a moment ago. Run as separate statements under READ COMMITTED,
// the INSERT waits for a concurrent insert of the same `sub` to finish and then returns nothing,
// and the SELECT (a fresh snapshot) sees the committed row. DO NOTHING, not DO UPDATE: nothing to
// update, and an update would write a dead tuple on every login.
const INSERT_USER_SQL =
  'INSERT INTO users (cognito_sub) VALUES ($1) ON CONFLICT (cognito_sub) DO NOTHING RETURNING id';
const SELECT_USER_SQL = 'SELECT id FROM users WHERE cognito_sub = $1';

type IdRow = { id: string };

/**
 * Maps a verified Cognito `sub` to `users.id`, creating the row at the first valid token of any
 * role (database-design §4.1, ADR-06). Roles are not stored: they come from `cognito:groups`.
 */
@Injectable()
export class IdentityService {
  /**
   * Holds promises, so N parallel first requests for one `sub` share a single pair of statements
   * (single-flight). `Map` iterates in insertion order, which gives least-recently-used eviction:
   * a hit is deleted and re-inserted.
   *
   * No TTL: `sub → id` never changes. That relies on `dbs_api` having no DELETE on `users`
   * (database-design §8); a dev who runs `migration:revert` then `run` while the process is up
   * must restart it. Correctness never depends on this cache — each process has its own, and
   * `ON CONFLICT` is what keeps two of them from creating two rows.
   */
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly tx: TransactionService) {}

  /** `users.id` of an already-verified `sub`. Never call it with a claim that was not verified. */
  resolveUserId(sub: string): Promise<string> {
    if (typeof sub !== 'string' || sub.length === 0) {
      return Promise.reject(new TypeError('sub must be a non-empty string'));
    }

    const cached = this.cache.get(sub);
    if (cached) {
      this.cache.delete(sub);
      this.cache.set(sub, cached);
      return cached;
    }

    const pending = this.lookupOrCreate(sub);
    this.cache.set(sub, pending);
    if (this.cache.size > USER_ID_CACHE_MAX) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    // A failure is never cached. Delete only if the entry is still this promise: the LRU may have
    // evicted it and a newer call may already have stored a different one for the same `sub`.
    pending.catch(() => {
      if (this.cache.get(sub) === pending) this.cache.delete(sub);
    });
    return pending;
  }

  /**
   * Inside `TransactionService.run` only to get its lock_timeout and statement_timeout. With bare
   * queries a lock held on `users` would make every first request of a new `sub` wait forever on
   * a pooled connection, and every route needs a token. Both statements are idempotent, so a
   * deadlock retry of the callback is safe.
   */
  private lookupOrCreate(sub: string): Promise<string> {
    return this.tx.run(async manager => {
      const inserted = await manager.query<IdRow[]>(INSERT_USER_SQL, [sub]);
      if (inserted.length > 0) return inserted[0].id;

      const existing = await manager.query<IdRow[]>(SELECT_USER_SQL, [sub]);
      if (existing.length > 0) return existing[0].id;

      // The row existed at INSERT time and is gone now: it was deleted by hand. Fail loudly (500)
      // instead of returning an id that points at nothing.
      throw new Error('users row vanished between INSERT ... ON CONFLICT and SELECT');
    });
  }
}
