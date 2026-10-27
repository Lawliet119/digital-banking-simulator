import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { LockedAccount } from './account.types';

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const SNAPSHOT_COLUMNS = `a.id, a.customer_id AS "customerId", c.user_id AS "userId",
  a.type, a.status, a.balance, a.created_at AS "createdAt", a.updated_at AS "updatedAt"`;

@Injectable()
export class AccountsService {
  constructor(@InjectDataSource() private readonly source: DataSource) {}

  async lockForUpdate(ids: string[], manager: EntityManager): Promise<LockedAccount[]> {
    this.requireTransaction(manager);
    if (!Array.isArray(ids)) throw new TypeError('Account ids must be an array of UUIDs');
    const normalized = [...new Set(ids.map(id => this.normalizeId(id)))];
    if (normalized.length === 0) return [];
    // OF a avoids locking the nullable side of the owner join. SQL order governs lock acquisition.
    return manager.query<LockedAccount[]>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM accounts a
       LEFT JOIN customers c ON c.id=a.customer_id
       WHERE a.id=ANY($1::uuid[]) ORDER BY a.id FOR UPDATE OF a`,
      [normalized],
    );
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
