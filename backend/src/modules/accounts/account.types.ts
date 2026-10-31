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
