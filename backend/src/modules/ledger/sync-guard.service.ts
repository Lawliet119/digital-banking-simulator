import { Inject, Injectable } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import { limitsConfig } from '@config/limits.config';
import { Clock } from '@common/clock';
import { AccountsService, type LockedAccount } from '@modules/accounts';
import { ErrorCode } from '@common/errors/error-code.enum';
import type { RejectReason } from '@common/errors/reject-reason';
import { parseBalance, type Money } from '@common/money';

/**
 * What the source account has already sent today, in Vietnam time (BR-06). $1 is the account, $2
 * is "now" (a `Clock`, read after the lock). The day starts at 00:00 Asia/Ho_Chi_Minh, computed
 * here from $2 so that PostgreSQL folds it into a constant: the plan is an Index Only Scan on
 * `ledger_entries_daily_debit_idx` that starts at the boundary. The boundary must NOT come from
 * `clock_timestamp()` inside this statement: that function is VOLATILE, cannot be an index
 * condition, and the same query became a Seq Scan (256 ms on a million lines, DBS-84). Debit lines
 * of a customer account only come from its own transfers, never from deposits.
 */
export const SENT_TODAY_SQL = `SELECT coalesce(sum(amount),0)::text AS total FROM ledger_entries
  WHERE account_id=$1 AND direction='DEBIT'
    AND created_at >= date_trunc('day', $2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')
                      AT TIME ZONE 'Asia/Ho_Chi_Minh'`;

/**
 * The synchronous guard of a transfer (docs/03 §6.1, BRD UC-5 step 6). It is cheap on purpose
 * (state, two comparisons, one indexed sum) and it only ever refuses; it never changes anything.
 */
@Injectable()
export class SyncGuardService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly clock: Clock,
    @Inject(limitsConfig.KEY) private readonly limits: ConfigType<typeof limitsConfig>,
  ) {}

  /**
   * Returns the first rule the transfer breaks, or `null` when it may go ahead. The order is the
   * order of priority and is part of the contract, because the client sees the reason:
   *
   *   1. ACCOUNT_NOT_ACTIVE      source or destination is not ACTIVE, or there is no destination
   *   2. LIMIT_PER_TX_EXCEEDED   amount above the per-transfer limit
   *   3. LIMIT_PER_DAY_EXCEEDED  what the source sent today plus this amount above the daily limit
   *   4. INSUFFICIENT_FUNDS      balance below the amount
   *
   * Call it ONLY after `AccountsService.lockForUpdate` locked both accounts in this transaction,
   * and always `await` it: the day total is trustworthy only while no other transfer from the
   * source can commit (AC-5.6), and a Promise that is not awaited is always truthy. The lock is
   * checked here, not assumed (AccountNotLockedError).
   *
   * @param lockedTo `undefined` when the destination does not exist or is not a customer account
   *   (for example the SYSTEM funding account). Those cases are one answer on purpose (AC-5.8).
   */
  async checkGuards(
    manager: EntityManager,
    lockedFrom: LockedAccount,
    lockedTo: LockedAccount | undefined,
    amount: Money,
  ): Promise<RejectReason | null> {
    this.accounts.assertLocked(lockedTo ? [lockedFrom.id, lockedTo.id] : [lockedFrom.id], manager);
    if (lockedFrom.status !== 'ACTIVE' || !lockedTo || lockedTo.status !== 'ACTIVE') {
      return ErrorCode.ACCOUNT_NOT_ACTIVE;
    }
    // Read at call time, not copied in the constructor: the limits are configuration.
    const { perTx, perDay } = this.limits.transfer;
    if (amount > perTx) return ErrorCode.LIMIT_PER_TX_EXCEEDED;
    const [{ total }]: { total: string }[] = await manager.query(SENT_TODAY_SQL, [
      lockedFrom.id,
      this.clock.now(),
    ]);
    if (BigInt(total) + amount > perDay) return ErrorCode.LIMIT_PER_DAY_EXCEEDED;
    if (parseBalance(lockedFrom.balance) < amount) return ErrorCode.INSUFFICIENT_FUNDS;
    return null;
  }
}
