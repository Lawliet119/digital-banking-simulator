/** Service snapshots are not HTTP DTOs. PostgreSQL bigint stays an exact decimal string. */
export interface Account {
  id: string;
  customerId: string | null;
  userId: string | null;
  type: 'CHECKING' | 'SAVINGS' | 'SYSTEM';
  status: 'ACTIVE' | 'LOCKED';
  balance: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * An account read by `lockForUpdate`: the snapshot plus the day total of the daily limit (BR-06),
 * which only a held row lock makes trustworthy. `sentDay` is the latest Vietnam day (`YYYY-MM-DD`)
 * with a DEBIT line, `sentToday` the sum of that day's lines as a decimal string. They are kept by
 * a trigger on `ledger_entries` (migration AddDailyDebitCounter, BL-418); `getOwnedAccount` and
 * the HTTP DTOs do not carry them.
 */
export interface LockedAccount extends Account {
  sentToday: string;
  sentDay: string | null;
}

export type AccountOwnershipAction = 'account.read' | 'account.transactions' | 'ledger.transfer';

/** Constructed by server code after JWT and the customer-role guard, never by a request DTO. */
export interface AccountOwnershipContext {
  readonly userId: string;
  readonly role: 'customer';
  readonly action: AccountOwnershipAction;
  readonly correlationId: string;
}
