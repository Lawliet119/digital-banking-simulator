import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { activeTransactionContext } from '@database/transaction.helper';
import { TransactionService } from '@database/transaction.service';
import { serializeMetadata } from './audit-metadata.guard';
import { NestedTransactionError, type AuditRecordInput } from './audit.types';

const INSERT_SQL = `INSERT INTO audit_log
  (actor_user_id, actor_role, action, outcome, target_type, target_id, correlation_id, metadata)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`;

@Injectable()
export class AuditService {
  constructor(private readonly transactionService: TransactionService) {}

  /**
   * Inserts in the caller's transaction, by the `manager` it passes in. No try/catch: any error
   * (a CHECK/FK violation, a bad metadata shape, a dropped connection) rejects unwrapped, so
   * `TransactionService.run` rolls back the whole transaction — fail-closed (DoD #2).
   */
  async record(manager: EntityManager, input: AuditRecordInput): Promise<void> {
    const metadata = serializeMetadata(input.metadata);
    await manager.query(INSERT_SQL, [
      input.actor,
      input.role,
      input.action,
      input.outcome,
      input.target.type,
      input.target.id,
      input.correlationId,
      metadata,
    ]);
  }

  /**
   * For a denial that must survive even though the command it describes fails (DoD #3): opens
   * its own transaction, records `DENIED`, commits. Call this before `BEGIN`ning the business
   * transaction, or after it has already committed/rolled back — never from inside another
   * `TransactionService.run` callback (that would hold a second pooled connection, and a deadlock
   * retry would insert the row twice). If this itself rejects, let it propagate: a denial that
   * could not be recorded must not be reported as a clean 404.
   */
  async recordDenied(input: Omit<AuditRecordInput, 'outcome'>): Promise<void> {
    if (activeTransactionContext.getStore() === true) {
      throw new NestedTransactionError();
    }
    await this.transactionService.run(manager =>
      this.record(manager, { ...input, outcome: 'DENIED' }),
    );
  }
}
