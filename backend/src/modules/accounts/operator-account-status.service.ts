import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import { AuditReason, AuditService } from '@modules/audit';
import { IdentityService } from '@modules/identity';
import { OutboxWriter } from '@modules/outbox';
import {
  OperatorAccountStatusResponseDto,
  fingerprintReason,
  parseAccountUuid,
  parseStatusReason,
  resolveLockReason,
  resolveUnlockReason,
} from './operator-account-status.dto';

export const ACCOUNT_LOCK_ACTION = 'account.lock';
export const ACCOUNT_UNLOCK_ACTION = 'account.unlock';

interface LockedCustomerAccountRow {
  id: string;
  type: 'CHECKING' | 'SAVINGS';
  status: 'ACTIVE' | 'LOCKED';
  updatedAt: Date;
  ownerUserId: string;
}

const SELECT_CUSTOMER_ACCOUNT_FOR_UPDATE_SQL = `
SELECT
  a.id,
  a.type,
  a.status,
  a.updated_at AS "updatedAt",
  c.user_id AS "ownerUserId"
FROM accounts a
JOIN customers c ON c.id = a.customer_id
WHERE a.id = $1::uuid
FOR UPDATE OF a
`;

const UPDATE_ACCOUNT_STATUS_SQL = `
UPDATE accounts
SET status = $2, updated_at = clock_timestamp()
WHERE id = $1::uuid
RETURNING updated_at AS "updatedAt"
`;

@Injectable()
export class OperatorAccountStatusService {
  constructor(
    private readonly tx: TransactionService,
    private readonly identity: IdentityService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxWriter,
  ) {}

  /**
   * UC-11 / FR-ACC-03 / FR-ID-05 / BR-12 / BR-13.
   * Locks a customer account in one transaction: row lock (`FOR UPDATE OF a`), status transition,
   * `users.sessions_revoked_at = clock_timestamp()`, fail-closed audit row, and `AccountStatusChanged`
   * outbox event (which never includes the lock reason).
   */
  lock(
    operatorId: string,
    accountId: string,
    rawBody: unknown,
    correlationId: string,
  ): Promise<OperatorAccountStatusResponseDto> {
    const normalizedAccountId = parseAccountUuid(accountId);
    const normalizedReason = parseStatusReason(rawBody);
    return this.changeStatus({
      operatorId,
      normalizedAccountId,
      normalizedReason,
      correlationId,
      targetStatus: 'LOCKED',
      action: ACCOUNT_LOCK_ACTION,
      auditReason: resolveLockReason(normalizedReason),
      revokeOwnerSessions: true,
    });
  }

  /**
   * UC-11 / FR-ACC-03 / BR-13.
   * Unlocks a customer account in one transaction: row lock (`FOR UPDATE OF a`), status transition,
   * fail-closed audit row, and `AccountStatusChanged` outbox event. Does not clear `sessions_revoked_at`.
   */
  unlock(
    operatorId: string,
    accountId: string,
    rawBody: unknown,
    correlationId: string,
  ): Promise<OperatorAccountStatusResponseDto> {
    const normalizedAccountId = parseAccountUuid(accountId);
    const normalizedReason = parseStatusReason(rawBody);
    return this.changeStatus({
      operatorId,
      normalizedAccountId,
      normalizedReason,
      correlationId,
      targetStatus: 'ACTIVE',
      action: ACCOUNT_UNLOCK_ACTION,
      auditReason: resolveUnlockReason(normalizedReason),
      revokeOwnerSessions: false,
    });
  }

  private changeStatus(params: {
    operatorId: string;
    normalizedAccountId: string;
    normalizedReason: string;
    correlationId: string;
    targetStatus: 'ACTIVE' | 'LOCKED';
    action: typeof ACCOUNT_LOCK_ACTION | typeof ACCOUNT_UNLOCK_ACTION;
    auditReason: AuditReason;
    revokeOwnerSessions: boolean;
  }): Promise<OperatorAccountStatusResponseDto> {
    const {
      operatorId,
      normalizedAccountId,
      normalizedReason,
      correlationId,
      targetStatus,
      action,
      auditReason,
      revokeOwnerSessions,
    } = params;

    return this.tx.run(async manager => {
      const rows = await manager.query<LockedCustomerAccountRow[]>(
        SELECT_CUSTOMER_ACCOUNT_FOR_UPDATE_SQL,
        [normalizedAccountId],
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundException('Account not found');
      }

      const canonicalAccountId = row.id.toLowerCase();
      const canonicalOwnerUserId = row.ownerUserId.toLowerCase();
      const canonicalOperatorId = operatorId.toLowerCase();
      const canonicalCorrelationId = correlationId.toLowerCase();
      const reasonFingerprint = fingerprintReason(normalizedReason);

      if (row.status === targetStatus) {
        await this.audit.record(manager, {
          actor: canonicalOperatorId,
          role: 'operator',
          action,
          outcome: 'SUCCESS',
          target: { type: 'account', id: canonicalAccountId },
          correlationId: canonicalCorrelationId,
          metadata: {
            id: reasonFingerprint,
            reason: auditReason,
          },
        });
        return {
          id: canonicalAccountId,
          type: row.type,
          status: row.status,
          updatedAt: row.updatedAt.toISOString(),
        };
      }

      // The pg driver answers an UPDATE ... RETURNING as [rows, affectedCount], unlike a SELECT.
      const [updatedRows] = await manager.query<[{ updatedAt: Date }[], number]>(
        UPDATE_ACCOUNT_STATUS_SQL,
        [canonicalAccountId, targetStatus],
      );
      const updatedAtIso = updatedRows[0].updatedAt.toISOString();

      if (revokeOwnerSessions) {
        await this.identity.revokeSessions(manager, canonicalOwnerUserId);
      }

      await this.audit.record(manager, {
        actor: canonicalOperatorId,
        role: 'operator',
        action,
        outcome: 'SUCCESS',
        target: { type: 'account', id: canonicalAccountId },
        correlationId: canonicalCorrelationId,
        metadata: {
          id: reasonFingerprint,
          reason: auditReason,
        },
      });

      await this.outbox.add(manager, {
        eventId: randomUUID(),
        eventType: 'AccountStatusChanged',
        occurredAt: updatedAtIso,
        correlationId: canonicalCorrelationId,
        accountId: canonicalAccountId,
        ownerUserId: canonicalOwnerUserId,
        newStatus: targetStatus,
        changedByUserId: canonicalOperatorId,
      });

      return {
        id: canonicalAccountId,
        type: row.type,
        status: targetStatus,
        updatedAt: updatedAtIso,
      };
    });
  }
}
