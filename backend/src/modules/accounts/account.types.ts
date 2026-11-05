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

export type LockedAccount = Account;

export type AccountOwnershipAction = 'account.read' | 'account.transactions' | 'ledger.transfer';

/** Constructed by server code after JWT and the customer-role guard, never by a request DTO. */
export interface AccountOwnershipContext {
  readonly userId: string;
  readonly role: 'customer';
  readonly action: AccountOwnershipAction;
  readonly correlationId: string;
}
