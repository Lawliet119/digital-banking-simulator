import { Injectable } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import { AuditService } from './audit.service';
import {
  buildAuditSearchSql,
  encodeAuditSearchCursor,
  type AuditEntry,
  type AuditEntriesPage,
  type ParsedAuditSearchQuery,
} from './audit-search.query';

interface AuditSearchRow extends Omit<AuditEntry, 'target'> {
  targetType: string;
  targetId: string;
}

@Injectable()
export class AuditSearchService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly audit: AuditService,
  ) {}

  search(
    query: ParsedAuditSearchQuery,
    caller: { userId: string; correlationId: string },
  ): Promise<AuditEntriesPage> {
    const { sql, parameters } = buildAuditSearchSql(query);
    const { limit, actorUserId, action, from, to, correlationId } = query;
    const filters = { actorUserId, action, from, to, correlationId };
    const actor = caller.userId;
    const serverCorrelationId = caller.correlationId;
    return this.transactions.run(async manager => {
      // The read is never published unless its audit committed. The server trace is deliberately
      // independent of the caller's trace filter; filters/cursor/query text never enter the audit.
      await this.audit.record(manager, {
        actor,
        role: 'auditor',
        action: 'audit.search',
        outcome: 'SUCCESS',
        target: { type: 'audit_search', id: serverCorrelationId },
        correlationId: serverCorrelationId,
        metadata: {},
      });
      const rows = await manager.query<AuditSearchRow[]>(sql, parameters);
      const entries: AuditEntry[] = rows.slice(0, limit).map(row => ({
        id: row.id,
        occurredAt: row.occurredAt,
        actorUserId: row.actorUserId,
        actorRole: row.actorRole,
        action: row.action,
        outcome: row.outcome,
        target: { type: row.targetType, id: row.targetId },
        correlationId: row.correlationId,
        metadata: row.metadata,
      }));
      return {
        entries,
        nextCursor:
          rows.length > limit
            ? encodeAuditSearchCursor(entries[entries.length - 1], filters)
            : null,
      };
    });
  }
}
