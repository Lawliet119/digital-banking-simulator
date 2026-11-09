import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { SessionRevocationCache } from './session-revocation-cache';

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

  constructor(
    private readonly tx: TransactionService,
    @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
    @Optional() private readonly revocationCache?: SessionRevocationCache,
  ) {}

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
   * When this user's sessions were last revoked, or null if never (docs/03 §6.2). A token issued at
   * or before that moment is refused. A cached marker can reject, but cannot admit a token:
   * a later lock may have committed while its cache SET failed or an older fill arrived late.
   */
  async sessionsRevokedAt(userId: string, issuedAt?: number): Promise<Date | null> {
    const cached = await this.revocationCache?.read(userId);
    if (cached && issuedAt !== undefined && issuedAt <= Math.floor(cached.getTime() / 1000)) {
      return cached;
    }
    const revokedAt = await this.readRevocation(userId);
    // The SELECT (or its fallback transaction) has finished before this cache fill.
    if (revokedAt) await this.publishRevocation(userId, revokedAt);
    return revokedAt;
  }

  /** Called after the caller's COMMIT, never from its retryable transaction callback. */
  async publishRevocation(userId: string, revokedAt: Date): Promise<void> {
    await this.revocationCache?.publish(userId, revokedAt);
  }

  private async readRevocation(userId: string): Promise<Date | null> {
    if (this.dataSource) {
      const rows = await this.dataSource.query<{ sessions_revoked_at: Date | null }[]>(
        'SELECT sessions_revoked_at FROM users WHERE id = $1',
        [userId],
      );
      return rows[0]?.sessions_revoked_at ?? null;
    }
    return this.tx.run(async manager => {
      const rows = await manager.query<{ sessions_revoked_at: Date | null }[]>(
        'SELECT sessions_revoked_at FROM users WHERE id = $1',
        [userId],
      );
      return rows[0]?.sessions_revoked_at ?? null;
    });
  }

  /**
   * Revokes every session of `userId` as of now, inside the caller's transaction so that locking an
   * account and cutting its owner's sessions commit together (docs/03 §6.2). The database clock is
   * used, never the application's.
   */
  async revokeSessions(manager: EntityManager, userId: string): Promise<Date> {
    // The pg driver answers an UPDATE ... RETURNING as [rows, affectedCount], unlike a SELECT.
    const [rows] = await manager.query<[{ sessions_revoked_at: Date }[], number]>(
      'UPDATE users SET sessions_revoked_at = clock_timestamp() WHERE id = $1 RETURNING sessions_revoked_at',
      [userId],
    );
    if (rows.length === 0) throw new Error('Cannot revoke sessions of an unknown user');
    return rows[0].sessions_revoked_at;
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
