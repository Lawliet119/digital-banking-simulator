import { Inject, Injectable } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { limitsConfig } from '@config/limits.config';
import { Clock } from '@common/clock';
import { TransactionService } from '@database/transaction.service';
import { AccountHolderReader, AccountsService } from '@modules/accounts';
import { AuditService } from '@modules/audit';
import type {
  CustomerSummaryDto,
  RecentRecipientsDto,
  TransferLimitsDto,
} from './customer-insights.dto';
import { SENT_TODAY_SQL } from './sync-guard.service';

export const MAX_RECENT_RECIPIENTS = 5;

/**
 * Money per account since the start of the window, in Vietnam days. `internal` marks a movement
 * between two of the caller's own accounts, which is left out of the totals. $1 own account ids,
 * $2 "now", $3 number of days including today.
 */
export const FLOW_SQL = `SELECT e.account_id AS "accountId",
  coalesce(sum(e.amount) FILTER (WHERE e.direction = 'CREDIT'), 0)::text AS "moneyIn",
  coalesce(sum(e.amount) FILTER (WHERE e.direction = 'DEBIT'), 0)::text AS "moneyOut",
  coalesce(sum(e.amount) FILTER (WHERE e.direction = 'CREDIT' AND NOT own.internal), 0)::text
    AS "outsideIn",
  coalesce(sum(e.amount) FILTER (WHERE e.direction = 'DEBIT' AND NOT own.internal), 0)::text
    AS "outsideOut",
  count(*)::int AS transactions
FROM ledger_entries e
JOIN transfers t ON t.id = e.transfer_id
CROSS JOIN LATERAL (
  SELECT t.from_account_id = ANY($1::uuid[]) AND t.to_account_id = ANY($1::uuid[]) AS internal
) own
WHERE e.account_id = ANY($1::uuid[])
  AND e.created_at >= (date_trunc('day', $2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')
        - make_interval(days => $3::int - 1)) AT TIME ZONE 'Asia/Ho_Chi_Minh'
GROUP BY e.account_id`;

/** Accounts the caller has completed a transfer to, newest first, their own accounts left out. */
export const RECIPIENTS_SQL = `SELECT t.to_account_id AS "accountId", max(t.created_at) AS "lastAt"
FROM transfers t
WHERE t.from_account_id = ANY($1::uuid[]) AND t.status = 'COMPLETED' AND t.type = 'TRANSFER'
  AND NOT t.to_account_id = ANY($1::uuid[])
GROUP BY t.to_account_id
ORDER BY max(t.created_at) DESC, t.to_account_id
LIMIT $2`;

interface FlowRow {
  accountId: string;
  moneyIn: string;
  moneyOut: string;
  outsideIn: string;
  outsideOut: string;
  transactions: number;
}

/** Read-only figures about the caller's own money. Nothing here is on the money path. */
@Injectable()
export class CustomerInsightsService {
  constructor(
    private readonly tx: TransactionService,
    private readonly accounts: AccountsService,
    private readonly holders: AccountHolderReader,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(limitsConfig.KEY) private readonly limits: ConfigType<typeof limitsConfig>,
  ) {}

  async limitsOf(
    userId: string,
    accountId: string,
    correlationId: string,
  ): Promise<TransferLimitsDto> {
    // Ownership first and outside the transaction: a refusal is 404 plus a DENIED row.
    const account = await this.accounts.getOwnedAccount(accountId, {
      userId,
      role: 'customer',
      action: 'account.limits',
      correlationId,
    });
    return this.tx.run<TransferLimitsDto>(async manager => {
      const rows: { total: string }[] = await manager.query(SENT_TODAY_SQL, [
        account.id,
        this.clock.now(),
      ]);
      const sent = BigInt(rows[0].total);
      const remaining = this.limits.transfer.perDay - sent;
      await this.audit.record(manager, {
        actor: userId,
        role: 'customer',
        action: 'account.limits',
        outcome: 'SUCCESS',
        target: { type: 'account', id: account.id },
        correlationId,
        metadata: { id: account.id },
      });
      return {
        perTransaction: this.limits.transfer.perTx.toString(),
        perDay: this.limits.transfer.perDay.toString(),
        sentToday: sent.toString(),
        remainingToday: (remaining > 0n ? remaining : 0n).toString(),
      };
    });
  }

  async summary(userId: string, days: 1 | 30, correlationId: string): Promise<CustomerSummaryDto> {
    return this.tx.run<CustomerSummaryDto>(async manager => {
      const own = await this.holders.ownedBy(manager, userId);
      const rows: FlowRow[] = await manager.query(FLOW_SQL, [
        own.map(account => account.accountId),
        this.clock.now(),
        days,
      ]);
      const byAccount = new Map(rows.map(row => [row.accountId, row]));
      const total = (pick: (row: FlowRow) => string) =>
        rows.reduce((sum, row) => sum + BigInt(pick(row)), 0n).toString();
      await this.audit.record(manager, {
        actor: userId,
        role: 'customer',
        action: 'account.summary',
        outcome: 'SUCCESS',
        target: { type: 'user', id: userId },
        correlationId,
        metadata: { count: own.length },
      });
      return {
        days,
        totalIn: total(row => row.outsideIn),
        totalOut: total(row => row.outsideOut),
        accounts: own.map(account => {
          const row = byAccount.get(account.accountId);
          return {
            accountId: account.accountId,
            accountNumber: account.accountNumber,
            moneyIn: row?.moneyIn ?? '0',
            moneyOut: row?.moneyOut ?? '0',
            transactions: row?.transactions ?? 0,
          };
        }),
      };
    });
  }

  async recipients(userId: string, correlationId: string): Promise<RecentRecipientsDto> {
    return this.tx.run<RecentRecipientsDto>(async manager => {
      const own = await this.holders.ownedBy(manager, userId);
      const rows: { accountId: string; lastAt: Date }[] = await manager.query(RECIPIENTS_SQL, [
        own.map(account => account.accountId),
        MAX_RECENT_RECIPIENTS,
      ]);
      const names = await this.holders.holdersOf(
        manager,
        rows.map(row => row.accountId),
      );
      const items = rows.flatMap(row => {
        const holder = names.get(row.accountId);
        return holder?.ownerName
          ? [
              {
                accountId: row.accountId,
                accountNumber: holder.accountNumber,
                ownerName: holder.ownerName,
                lastTransferAt: row.lastAt.toISOString(),
              },
            ]
          : [];
      });
      await this.audit.record(manager, {
        actor: userId,
        role: 'customer',
        action: 'account.recipients',
        outcome: 'SUCCESS',
        target: { type: 'user', id: userId },
        correlationId,
        metadata: { count: items.length },
      });
      return { items };
    });
  }
}
