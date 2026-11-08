import { Injectable } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import { AuditService } from '@modules/audit';
import { OperatorAccountDto, OperatorAccountSearchDto } from './operator-account-search.dto';
import {
  buildSearchSql,
  fingerprintTerm,
  type ParsedSearch,
} from './operator-account-search.query';

export const SEARCH_ACTION = 'operator.account.search';

@Injectable()
export class OperatorAccountSearchService {
  constructor(
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * FR-ACC-04 / BR-10. The lookup and its audit row are one transaction: the operator gets no data
   * from a lookup that could not be recorded. The row keeps who looked (actor), how many accounts
   * came back and what was asked for as an account id (a UUID) or, for a name, only a SHA-256
   * fingerprint: the audit log never stores a customer's name (`audit-metadata.guard.ts`).
   */
  search(
    operatorId: string,
    search: ParsedSearch,
    correlationId: string,
  ): Promise<OperatorAccountSearchDto> {
    return this.tx.run(async manager => {
      const { sql, parameters } = buildSearchSql(search);
      const rows: OperatorAccountDto[] = await manager.query(sql, parameters);
      // Copy field by field: only what is named here can leave the service.
      const items = rows.map(row => ({
        id: row.id,
        type: row.type,
        status: row.status,
        ownerName: row.ownerName,
      }));
      await this.audit.record(manager, {
        actor: operatorId,
        role: 'operator',
        action: SEARCH_ACTION,
        outcome: 'SUCCESS',
        target:
          search.kind === 'id'
            ? { type: 'account', id: search.term }
            : { type: 'account_search', id: fingerprintTerm(search.term) },
        correlationId,
        metadata: { count: items.length },
      });
      return { items };
    });
  }
}
