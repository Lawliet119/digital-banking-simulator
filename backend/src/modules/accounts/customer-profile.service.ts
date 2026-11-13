import { Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { AuditService, type AuditAction } from '@modules/audit';
import { CustomerProfileDto } from './customer-profile.dto';

interface ProfileRow {
  id: string;
  fullName: string;
  createdAt: Date;
}

const SELECT_PROFILE = `SELECT id, full_name AS "fullName", created_at AS "createdAt"
  FROM customers WHERE user_id = $1`;

@Injectable()
export class CustomerProfileService {
  constructor(
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  createOrGet(
    userId: string,
    fullName: string,
    correlationId: string,
  ): Promise<CustomerProfileDto> {
    return this.tx.run(async manager => {
      const inserted: ProfileRow[] = await manager.query(
        `INSERT INTO customers (user_id, full_name) VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING id, full_name AS "fullName", created_at AS "createdAt"`,
        [userId, fullName],
      );
      // Separate statement sees the winner after the unique-conflict wait at READ COMMITTED.
      const rows: ProfileRow[] = inserted.length
        ? inserted
        : await manager.query(SELECT_PROFILE, [userId]);
      const profile = rows[0];
      if (!profile) throw new Error('Customer conflict resolved without a profile');
      await this.record(
        manager,
        userId,
        profile.id,
        correlationId,
        inserted.length ? 'customer.created' : 'customer.read',
      );
      return this.response(profile);
    });
  }

  get(userId: string, correlationId: string): Promise<CustomerProfileDto> {
    return this.tx.run(async manager => {
      const rows: ProfileRow[] = await manager.query(SELECT_PROFILE, [userId]);
      if (!rows[0]) throw new NotFoundException('Customer profile not found');
      await this.record(manager, userId, rows[0].id, correlationId, 'customer.read');
      return this.response(rows[0]);
    });
  }

  private record(
    manager: EntityManager,
    userId: string,
    id: string,
    correlationId: string,
    action: AuditAction,
  ) {
    return this.audit.record(manager, {
      actor: userId,
      role: 'customer',
      action,
      outcome: 'SUCCESS',
      target: { type: 'customer', id },
      correlationId,
      metadata: { id },
    });
  }

  private response(row: ProfileRow): CustomerProfileDto {
    return { id: row.id, fullName: row.fullName, createdAt: row.createdAt.toISOString() };
  }
}
