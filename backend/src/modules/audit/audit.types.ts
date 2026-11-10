import { ErrorCode } from '@common/errors/error-code.enum';

export type AuditOutcome = 'SUCCESS' | 'REJECTED' | 'DENIED';

export interface AuditTarget {
  type: string;
  id: string;
}

/**
 * Audit-only reason codes for denials and operator administrative actions that have no matching
 * `ErrorCode` (a transfer/deposit business rejection). Extend only when a caller needs to branch on
 * it, same rule as `ErrorCode`.
 */
export enum AuditReason {
  NOT_OWNER = 'NOT_OWNER',
  NO_PERMISSION = 'NO_PERMISSION',
  OPERATOR_LOCK = 'OPERATOR_LOCK',
  OPERATOR_UNLOCK = 'OPERATOR_UNLOCK',
  SUSPICIOUS_ACTIVITY = 'SUSPICIOUS_ACTIVITY',
  CONFIRMED_FRAUD = 'CONFIRMED_FRAUD',
  CUSTOMER_REQUEST = 'CUSTOMER_REQUEST',
  COMPLIANCE_HOLD = 'COMPLIANCE_HOLD',
  FRAUD_FALSE_POSITIVE = 'FRAUD_FALSE_POSITIVE',
}

/**
 * Only id, a closed reason code and a count — never a free-text description, name or email.
 * `reason` is a closed registry (`ErrorCode` or `AuditReason`), not a string, so a caller cannot
 * smuggle PII through it the way a free-text field would allow.
 */
export interface AuditMetadata {
  id?: string;
  reason?: ErrorCode | AuditReason;
  count?: number;
}

export interface AuditRecordInput {
  /** `users.id`, not the Cognito `sub`. `null` for a system/worker action with no logged-in user. */
  actor: string | null;
  /** Free text from `cognito:groups` (customer/operator/auditor/admin/system, ...). */
  role: string;
  action: string;
  outcome: AuditOutcome;
  target: AuditTarget;
  correlationId: string;
  metadata?: AuditMetadata;
}

/** Thrown by the metadata guard. Message is fixed and never echoes the rejected value. */
export class AuditMetadataError extends Error {
  constructor() {
    super('audit metadata chứa field hoặc giá trị không hợp lệ');
    this.name = 'AuditMetadataError';
  }
}

/**
 * Thrown by `recordDenied()` when called from inside another already-open transaction (DBS-56
 * vòng 2, F-2) — a deadlock retry would otherwise insert the DENIED row twice. Message is fixed
 * and never echoes input, same pattern as `AuditMetadataError`.
 */
export class NestedTransactionError extends Error {
  constructor() {
    super('recordDenied() không được gọi khi đang có transaction khác đang mở');
    this.name = 'NestedTransactionError';
  }
}
