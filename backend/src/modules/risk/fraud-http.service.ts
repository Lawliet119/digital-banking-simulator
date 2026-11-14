import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import { AuditReason, AuditService } from '@modules/audit';
import { buildHistorySql, transferCorrelationId, type TransactionItemDto } from '@modules/ledger';
import { ErrorCode } from '@common/errors/error-code.enum';
import { FraudDetailDto, FraudFlagDto, FraudListDto, ReviewFraudDto } from './fraud-http.dto';
import { cursorFor, type FraudQuery } from './fraud-http.query';

const PROJECTION = `f.transfer_id AS "transferId", t.from_account_id AS "fromAccountId",
 t.to_account_id AS "toAccountId", f.score, f.risk_level AS "riskLevel",
 f.review_status AS "reviewStatus", f.rule_set_version AS "ruleSetVersion",
 to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`;

@Injectable()
export class FraudHttpService {
  constructor(
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  list(query: FraudQuery, actor: string, correlationId: string): Promise<FraudListDto> {
    return this.tx.run(async manager => {
      const rows: FraudFlagDto[] = await manager.query(
        `SELECT ${PROJECTION}
        FROM fraud_flags f JOIN v_transfer_facts t ON t.id = f.transfer_id
        WHERE f.review_status = $1 AND ($2::text IS NULL OR f.risk_level = $2)
        AND ($3::text IS NULL OR f.risk_level > $3 OR
          (f.risk_level = $3 AND (f.created_at, f.transfer_id) < ($4::timestamptz, $5::uuid)))
        ORDER BY f.risk_level, f.created_at DESC, f.transfer_id DESC LIMIT $6`,
        [
          query.status,
          query.level,
          query.after ? (query.after.rank === 0 ? 'HIGH' : 'MEDIUM') : null,
          query.after?.time ?? null,
          query.after?.id ?? null,
          query.limit + 1,
        ],
      );
      const items = rows.slice(0, query.limit);
      await this.audit.record(manager, {
        actor,
        role: 'operator',
        action: 'fraud_flag.search',
        outcome: 'SUCCESS',
        target: { type: 'fraud_flag_search', id: correlationId },
        correlationId,
        metadata: { count: items.length },
      });
      return {
        items,
        nextCursor: rows.length > query.limit ? cursorFor(query, items[items.length - 1]) : null,
      };
    });
  }

  detail(id: string, actor: string, correlationId: string): Promise<FraudDetailDto> {
    return this.tx.run(async manager => {
      const rows = await manager.query<Omit<FraudDetailDto, 'hits' | 'recentTransactions'>[]>(
        `SELECT ${PROJECTION},
        CASE WHEN d.mode = 'rule_only' THEN NULL ELSE json_build_object(
          'status', d.ai_status, 'probability', d.probability,
          'model', COALESCE(d.response_model, d.requested_model), 'rubricSha256', d.rubric_sha256) END AS "aiAssessment"
        FROM fraud_flags f JOIN risk_decisions d ON d.transfer_id = f.transfer_id
        JOIN v_transfer_facts t ON t.id = f.transfer_id WHERE f.transfer_id = $1`,
        [id],
      );
      if (!rows.length) throw new NotFoundException('Fraud flag not found');
      const hits = await manager.query<FraudDetailDto['hits']>(
        `SELECT rule_id AS "ruleId", weight, explanation
        FROM fraud_rule_hits WHERE transfer_id = $1 ORDER BY rule_id`,
        [id],
      );
      const history = buildHistorySql(rows[0].fromAccountId, {
        from: null,
        to: null,
        cursor: null,
        limit: 10,
      });
      const movements = await manager.query<TransactionItemDto[]>(history.sql, history.parameters);
      const recentTransactions = movements.slice(0, 10).map(row => ({
        entryId: row.entryId,
        transferId: row.transferId,
        type: row.type,
        direction: row.direction,
        amount: row.amount,
        balanceAfter: row.balanceAfter,
        counterpartyAccountId: row.counterpartyAccountId,
        createdAt: row.createdAt,
      }));
      // BL-226 (DBS-135, AC-8.2): a view of one flag is a step of that transfer's chain, same as
      // the review, so the auditor who looks up the transfer's code sees who opened the flag. The
      // request's own code stays in metadata.id (log lines, response header). The flag was read
      // above, so its transfer exists (foreign key): no fallback to the request code.
      const chainCode = await transferCorrelationId(manager, id);
      if (!chainCode) throw new Error('Transfer of a viewed flag has no correlationId');
      await this.audit.record(manager, {
        actor,
        role: 'operator',
        action: 'fraud_flag.view',
        outcome: 'SUCCESS',
        target: { type: 'fraud_flag', id },
        correlationId: chainCode,
        metadata: { id: correlationId },
      });
      return { ...rows[0], hits, recentTransactions };
    });
  }

  review(
    id: string,
    body: ReviewFraudDto,
    actor: string,
    correlationId: string,
  ): Promise<{ transferId: string; reviewStatus: string }> {
    return this.tx.run(async manager => {
      // RETURNING is required: TypeORM PostgreSQL UPDATE returns [rows, affectedCount].
      const result = await manager.query<[Array<{ transfer_id: string }>, number]>(
        `UPDATE fraud_flags SET review_status = $2,
        reviewed_by = $3, reviewed_at = clock_timestamp(), review_note = $4
        WHERE transfer_id = $1 AND review_status = 'OPEN' RETURNING transfer_id`,
        [id, body.decision, actor, body.note ?? null],
      );
      if (!result[1]) {
        const found = await manager.query<unknown[]>(
          'SELECT 1 FROM fraud_flags WHERE transfer_id = $1',
          [id],
        );
        if (!found.length) throw new NotFoundException('Fraud flag not found');
        throw new ConflictException({
          errorCode: ErrorCode.FLAG_ALREADY_REVIEWED,
          message: 'Fraud flag already reviewed',
        });
      }
      // DBS-135 (AC-8.2): the review is a step of the transfer's chain, so its audit line carries
      // the code of the transfer, not the code of this request. The request's own code stays in
      // metadata.id, which keeps the line linked to this request's log lines and response header.
      // No fallback to the request code: a missing transfer cannot happen after the UPDATE above
      // (foreign key), so fail the transaction rather than file the line under the wrong chain.
      const chainCode = await transferCorrelationId(manager, id);
      if (!chainCode) throw new Error('Transfer of a reviewed flag has no correlationId');
      await this.audit.record(manager, {
        actor,
        role: 'operator',
        action: 'fraud_flag.review',
        outcome: 'SUCCESS',
        target: { type: 'fraud_flag', id },
        correlationId: chainCode,
        metadata: {
          reason:
            body.decision === 'CONFIRMED_FRAUD'
              ? AuditReason.CONFIRMED_FRAUD
              : AuditReason.FRAUD_FALSE_POSITIVE,
          id: correlationId,
        },
      });
      return { transferId: id, reviewStatus: body.decision };
    });
  }
}
