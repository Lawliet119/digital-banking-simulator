import { ErrorCode } from './error-code.enum';

/**
 * Why a transfer ended REJECTED. Stored in `transfers.reject_reason` and returned to the client
 * as `errorCode`, so the persisted value and the wire value are the same string.
 */
export const REJECT_REASONS = [
  ErrorCode.ACCOUNT_NOT_ACTIVE,
  ErrorCode.LIMIT_PER_TX_EXCEEDED,
  ErrorCode.LIMIT_PER_DAY_EXCEEDED,
  ErrorCode.INSUFFICIENT_FUNDS,
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];

export function isRejectReason(value: unknown): value is RejectReason {
  return REJECT_REASONS.includes(value as RejectReason);
}
