import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { Account, LockedAccount } from './account.types';
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
const SNAPSHOT_COLUMNS = `a.id, a.customer_id AS "customerId", c.user_id AS "userId",
  a.type, a.status, a.balance, a.created_at AS "createdAt", a.updated_at AS "updatedAt"`;

@Injectable()
export class AccountsService {
  constructor(@InjectDataSource() private readonly source: DataSource) {}

  async lockForUpdate(ids: string[], manager: EntityManager): Promise<LockedAccount[]> {
    this.requireTransaction(manager);
    if (!Array.isArray(ids)) throw new TypeError('Account ids must be an array of UUIDs');
    const normalized = [...new Set(Array.from(ids, id => this.normalizeId(id)))];
    if (normalized.length === 0) return [];
    // OF a avoids locking the nullable side of the owner join. SQL order governs lock acquisition.
    return manager.query<LockedAccount[]>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM accounts a
       LEFT JOIN customers c ON c.id=a.customer_id
       WHERE a.id=ANY($1::uuid[]) ORDER BY a.id FOR UPDATE OF a`,
      [normalized],
    );
  }

  async applyBalanceChange(
    accountId: string,
    delta: bigint,
    manager: EntityManager,
  ): Promise<void> {
    this.requireTransaction(manager);
    const id = this.normalizeId(accountId);
    if (typeof delta !== 'bigint') throw new TypeError('Balance deltas must be bigint');
    // PostgreSQL remains the final guard against customer overdrafts and signed-bigint overflow.
    // clock_timestamp(), not now(): now() is the transaction start, so a writer that waited for this
    // row lock would stamp an earlier time than the writer it waited behind.
    let result: unknown;
    try {
      result = await manager.query(
        `UPDATE accounts SET balance=balance+$2::bigint, updated_at=clock_timestamp()
         WHERE id=$1::uuid RETURNING id`,
        [id, delta.toString()],
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

  async getOwnedAccount(accountId: string, userId: string): Promise<Account> {
    // Invalid, absent and foreign identifiers all hide account existence behind the same 404.
    if (
      typeof accountId !== 'string' ||
      !UUID_PATTERN.test(accountId) ||
      typeof userId !== 'string' ||
      !UUID_PATTERN.test(userId)
    ) {
      throw new NotFoundException('Account not found');
    }
    const [account] = await this.source.query<Account[]>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM accounts a
       JOIN customers c ON c.id=a.customer_id
       WHERE a.id=$1::uuid AND c.user_id=$2::uuid`,
      [accountId.toLowerCase(), userId.toLowerCase()],
    );
    if (!account) throw new NotFoundException('Account not found');
    return account;
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

  private requireTransaction(manager: EntityManager): void {
    const runner = manager?.queryRunner;
    if (!runner?.isTransactionActive || runner.isReleased) {
      throw new Error('An active caller transaction is required');
    }
  }

  private normalizeId(value: unknown): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new TypeError('Account ids must be UUIDs');
    }
    return value.toLowerCase();
  }
}
