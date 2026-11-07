import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';
import type { Account, AccountOwnershipContext, LockedAccount } from './account.types';
import { AuditReason, AuditService } from '@modules/audit';
import { activeTransactionContext } from '@database/transaction.helper';
import {
  AccountBalanceNegativeError,
  AccountBalanceOverflowError,
  AccountNotLockedError,
} from './accounts.errors';

interface PgFailure {
  code?: unknown;
  constraint?: unknown;
  driverError?: { code?: unknown; constraint?: unknown };
}

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const MAX_LOCKED_ACCOUNTS = 16;
const MAX_ID_ENTRIES = 256;

/** Ids this runner locked, tagged with the PostgreSQL transaction that holds the row locks. */
interface HeldLocks {
  txid: string;
  ids: Set<string>;
}

type LockedRow = LockedAccount & { txid: string };

const SNAPSHOT_COLUMNS = `a.id, a.customer_id AS "customerId", c.user_id AS "userId",
  a.type, a.status, a.balance, a.created_at AS "createdAt", a.updated_at AS "updatedAt"`;

@Injectable()
export class AccountsService {
  // Weak keys: a released runner and its marks are collected together; retries get a new runner.
  private readonly locks = new WeakMap<QueryRunner, HeldLocks>();

  constructor(
    @InjectDataSource() private readonly source: DataSource,
    private readonly audit: AuditService,
  ) {}

  async lockForUpdate(ids: string[], manager: EntityManager): Promise<LockedAccount[]> {
    const runner = this.requireOutermostTransaction(manager);
    if (!Array.isArray(ids)) throw new TypeError('Account ids must be an array of UUIDs');
    const normalized = this.distinctIds(ids);
    if (normalized.length === 0) return [];
    // OF a avoids locking the nullable side of the owner join. SQL order governs lock acquisition.
    const rows = await manager.query<LockedRow[]>(
      `SELECT ${SNAPSHOT_COLUMNS}, pg_current_xact_id()::text AS txid FROM accounts a
       LEFT JOIN customers c ON c.id=a.customer_id
       WHERE a.id=ANY($1::uuid[]) ORDER BY a.id FOR UPDATE OF a`,
      [normalized],
    );
    // No row means no lock was taken and no txid is known, so the existing mark stays as it was.
    if (rows.length > 0) this.remember(runner, rows);
    return rows.map(({ txid: _txid, ...account }) => account);
  }

  /**
   * Throws AccountNotLockedError unless every id was locked with `lockForUpdate` by THIS
   * transaction. For code that reads what only a held lock makes trustworthy (a daily total, a
   * balance snapshot) and must refuse to answer without it. It asks no question of the database:
   * a runner belongs to one transaction attempt, so the marks `lockForUpdate` left on it are the
   * lock state.
   */
  assertLocked(ids: string[], manager: EntityManager): void {
    const runner = this.requireOutermostTransaction(manager);
    const held = this.locks.get(runner);
    for (const value of ids) {
      const id = this.normalizeId(value);
      if (!held?.ids.has(id)) throw new AccountNotLockedError(id);
    }
  }

  async applyBalanceChange(
    accountId: string,
    delta: bigint,
    manager: EntityManager,
  ): Promise<void> {
    const runner = this.requireOutermostTransaction(manager);
    const id = this.normalizeId(accountId);
    if (typeof delta !== 'bigint') throw new TypeError('Balance deltas must be bigint');
    const held = this.locks.get(runner);
    if (!held?.ids.has(id)) throw new AccountNotLockedError(id);
    // PostgreSQL remains the final guard against customer overdrafts and signed-bigint overflow.
    // clock_timestamp(), not now(): now() is the transaction start, so a writer that waited for this
    // row lock would stamp an earlier time than the writer it waited behind.
    let result: unknown;
    try {
      result = await manager.query(
        `UPDATE accounts SET balance=balance+$2::bigint, updated_at=clock_timestamp()
         WHERE id=$1::uuid AND pg_current_xact_id()::text=$3 RETURNING id`,
        // A runner reused for a new transaction no longer holds the lock this txid stands for.
        [id, delta.toString(), held.txid],
      );
    } catch (error) {
      throw this.balanceFailure(id, error);
    }
    // Trust the RETURNING rows, not the driver's row count: a changed result shape must never
    // read as a successful money movement.
    if (!Array.isArray(result) || !Array.isArray(result[0])) {
      throw new Error('Unexpected UPDATE result shape');
    }
    if (result[0].length === 0) throw new AccountNotLockedError(id);
  }

  async getOwnedAccount(accountId: string, context: AccountOwnershipContext): Promise<Account> {
    if (context === null || typeof context !== 'object' || Array.isArray(context)) {
      throw new TypeError('Account ownership context is invalid');
    }
    // Capture trusted scalar fields once: a caller can mutate its object while SELECT waits.
    // Spreading or serializing it would also invoke unrelated getters or toJSON hooks.
    const { userId, role, action, correlationId } = context;
    if (
      typeof userId !== 'string' ||
      !UUID_PATTERN.test(userId) ||
      typeof correlationId !== 'string' ||
      !UUID_PATTERN.test(correlationId) ||
      role !== 'customer' ||
      (action !== 'account.read' &&
        action !== 'account.transactions' &&
        action !== 'ledger.transfer')
    ) {
      throw new TypeError('Account ownership context is invalid');
    }
    // Enforce the same boundary on owned and denied paths, before taking any pooled connection.
    // Denial must commit independently; a caller must therefore check ownership before BEGIN.
    if (activeTransactionContext.getStore() === true) {
      throw new TypeError('Account ownership cannot run inside a transaction');
    }
    const actor = userId.toLowerCase();
    const requestId = correlationId.toLowerCase();
    const id =
      typeof accountId === 'string' && UUID_PATTERN.test(accountId)
        ? accountId.toLowerCase()
        : 'invalid';
    if (id !== 'invalid') {
      const [account] = await this.source.query<Account[]>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM accounts a
         JOIN customers c ON c.id=a.customer_id
         WHERE a.id=$1::uuid AND c.user_id=$2::uuid`,
        [id, actor],
      );
      if (account) return account;
    }
    // No catch: an audit failure must propagate instead of becoming an unaudited clean 404.
    await this.audit.recordDenied({
      actor,
      role,
      action,
      target: { type: 'account', id },
      correlationId: requestId,
      metadata: { reason: AuditReason.NOT_OWNER },
    });
    throw new NotFoundException('Account not found');
  }

  /**
   * Only the two refusals that mean "the guard let a bad amount through" are given a type. Every
   * other failure (deadlock, timeout, another CHECK) passes through untouched so the retry and
   * transient classification still see it as it came from the driver.
   */
  private balanceFailure(accountId: string, error: unknown): unknown {
    const record = error !== null && typeof error === 'object' ? (error as PgFailure) : {};
    const code = record.driverError?.code ?? record.code;
    const constraint = record.driverError?.constraint ?? record.constraint;
    if (code === '23514' && constraint === 'accounts_balance_non_negative') {
      return new AccountBalanceNegativeError(accountId, { cause: error });
    }
    if (code === '22003') return new AccountBalanceOverflowError(accountId, { cause: error });
    return error;
  }

  /**
   * A money movement locks two or three accounts. Both caps fail fast before any regex work or row
   * lock, so a bulk caller cannot hold hundreds of locks against concurrent transfers.
   */
  private distinctIds(ids: string[]): string[] {
    if (ids.length > MAX_ID_ENTRIES) {
      throw new TypeError(`At most ${MAX_ID_ENTRIES} account id entries are accepted`);
    }
    const seen = new Set<string>();
    for (const id of Array.from(ids)) {
      seen.add(this.normalizeId(id));
      if (seen.size > MAX_LOCKED_ACCOUNTS) {
        throw new TypeError(`At most ${MAX_LOCKED_ACCOUNTS} account ids can be locked at once`);
      }
    }
    return [...seen];
  }

  private remember(runner: QueryRunner, rows: LockedRow[]): void {
    const txid = rows[0].txid;
    const held = this.locks.get(runner);
    const ids = held?.txid === txid ? held.ids : new Set<string>();
    for (const row of rows) ids.add(row.id);
    this.locks.set(runner, { txid, ids });
  }

  private requireOutermostTransaction(manager: EntityManager): QueryRunner {
    const runner = manager?.queryRunner;
    if (!runner?.isTransactionActive || runner.isReleased) {
      throw new Error('An active caller transaction is required');
    }
    // ROLLBACK TO SAVEPOINT releases row locks taken after the savepoint while
    // pg_current_xact_id() stays the same, so a lock taken in a nested transaction cannot be
    // trusted. TypeORM keeps the depth protected; an unreadable value fails closed.
    const depth = (runner as unknown as { transactionDepth?: unknown }).transactionDepth;
    if (depth !== 1) {
      throw new Error('Account locks must be taken at the outermost transaction');
    }
    return runner;
  }

  private normalizeId(value: unknown): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new TypeError('Account ids must be UUIDs');
    }
    return value.toLowerCase();
  }
}
