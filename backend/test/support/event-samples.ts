/**
 * Valid sample events shared by the specs of `@common/events` and the manual-test driver
 * (DBS-24 §4). Typed as the event types, so a field added to a type without updating these samples
 * is a compile error. Lives under `test/` on purpose: `nest build` ships `src/` only.
 *
 * Ids are lower-case canonical uuids; times are UTC with `Z`, as the contract requires.
 */
import type { AccountStatusChanged, TransferCompleted } from '@common/events/event-types';

/** Fixed id of the SYSTEM `funding` account (migration 1, ADR-09). It has no letters in it. */
export const FUNDING_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

/** A customer sends 500,000đ to another customer. */
export const TRANSFER_SAMPLE: TransferCompleted = {
  eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
  eventType: 'TransferCompleted',
  occurredAt: '2026-10-19T03:15:42.123Z',
  correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
  transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
  type: 'TRANSFER',
  fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
  toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  amount: '500000',
  fromBalanceBefore: '520000',
  fromAccountCreatedAt: '2026-09-30T08:00:00.000Z',
  toAccountCreatedAt: '2026-01-15T08:00:00.000Z',
  sameOwner: false,
  fromUserId: 'b2e5c8a1-6f40-4d93-8c17-a9d3f0e6b724',
  toUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
};

/** The operator deposits 300,000đ; `funding` was at -1,000,000đ and has no owner (ADR-09). */
export const DEPOSIT_SAMPLE: TransferCompleted = {
  eventId: '6b1e4a52-9c0d-4f7e-8a31-2d5c7e9f0a14',
  eventType: 'TransferCompleted',
  occurredAt: '2026-10-19T03:15:42.123Z',
  correlationId: 'c0a8f3d2-5b61-4e0a-9f27-7d1b3a6c8e55',
  transferId: '8f3c0a52-3b1e-4c9a-9d2e-5a7f1c0b6e11',
  type: 'DEPOSIT',
  fromAccountId: FUNDING_ACCOUNT_ID,
  toAccountId: '3d9e1b7a-4c25-4f08-b6a3-9e2f5d8c1a47',
  amount: '300000',
  fromBalanceBefore: '-1000000',
  fromAccountCreatedAt: '2026-10-12T02:00:00.000Z',
  toAccountCreatedAt: '2026-10-18T09:30:00.000Z',
  sameOwner: false,
  fromUserId: null,
  toUserId: 'a7c2e4f1-0b93-4d6a-8e15-3f9b1d7c5a02',
};

/** An operator locks an account. */
export const ACCOUNT_LOCKED_SAMPLE: AccountStatusChanged = {
  eventId: 'a1c9e3b7-4d52-4f06-8b3a-6e0d2c7f9514',
  eventType: 'AccountStatusChanged',
  occurredAt: '2026-10-19T04:02:10.456Z',
  correlationId: 'e8f2a6d0-1c47-4b95-a3e1-9d5b7c0f2836',
  accountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  ownerUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
  newStatus: 'LOCKED',
  changedByUserId: '4a6d9e02-8c17-4b53-a2f6-0e5d3c8b1974',
};

/** The same account is unlocked later. */
export const ACCOUNT_ACTIVE_SAMPLE: AccountStatusChanged = {
  ...ACCOUNT_LOCKED_SAMPLE,
  eventId: 'f5b8d1a3-7e60-4c29-9d84-0a3c6e1b7f92',
  occurredAt: '2026-10-19T05:30:00.000Z',
  newStatus: 'ACTIVE',
};

/** Every valid sample, for specs that must hold for all of them. */
export const VALID_SAMPLES = {
  TRANSFER: TRANSFER_SAMPLE,
  DEPOSIT: DEPOSIT_SAMPLE,
  ACCOUNT_LOCKED: ACCOUNT_LOCKED_SAMPLE,
  ACCOUNT_ACTIVE: ACCOUNT_ACTIVE_SAMPLE,
} as const;
