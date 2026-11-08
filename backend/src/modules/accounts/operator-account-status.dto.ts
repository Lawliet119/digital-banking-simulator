import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import { AuditReason } from '@modules/audit';

export const MAX_REASON_LENGTH = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONE_SURROGATE_PATTERN = /[\uD800-\uDFFF]/;

const KNOWN_LOCK_REASONS: ReadonlyMap<string, AuditReason> = new Map<string, AuditReason>([
  [AuditReason.CONFIRMED_FRAUD, AuditReason.CONFIRMED_FRAUD],
  [AuditReason.SUSPICIOUS_ACTIVITY, AuditReason.SUSPICIOUS_ACTIVITY],
  [AuditReason.CUSTOMER_REQUEST, AuditReason.CUSTOMER_REQUEST],
  [AuditReason.COMPLIANCE_HOLD, AuditReason.COMPLIANCE_HOLD],
  [AuditReason.OPERATOR_LOCK, AuditReason.OPERATOR_LOCK],
]);

const KNOWN_UNLOCK_REASONS: ReadonlyMap<string, AuditReason> = new Map<string, AuditReason>([
  [AuditReason.CUSTOMER_REQUEST, AuditReason.CUSTOMER_REQUEST],
  [AuditReason.COMPLIANCE_HOLD, AuditReason.COMPLIANCE_HOLD],
  [AuditReason.OPERATOR_UNLOCK, AuditReason.OPERATOR_UNLOCK],
]);

function invalid(message: string): never {
  throw new BadRequestException({ errors: [message] });
}

/**
 * Request body for `POST /v1/operator/accounts/{id}/lock` and `/unlock`.
 * `@Allow()` lets the global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`
 * keep `reason` while rejecting unknown properties; `parseStatusReason` enforces the full contract.
 */
export class OperatorAccountStatusBodyDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: MAX_REASON_LENGTH,
    example: 'CONFIRMED_FRAUD',
    description:
      'Reason code (CONFIRMED_FRAUD, SUSPICIOUS_ACTIVITY, CUSTOMER_REQUEST, COMPLIANCE_HOLD, OPERATOR_LOCK, OPERATOR_UNLOCK) or operator note (1..200 chars after NFC+trim, no control characters). Never exposed in outbox events or customer responses (BR-13).',
  })
  @Allow()
  reason?: unknown;
}

/** Four fields and no balance or reason (FR-ACC-03, BR-13). */
export class OperatorAccountStatusResponseDto {
  @ApiProperty({ format: 'uuid', example: '2e859a80-d4d0-471d-8cee-e9d0de9d4bc7' })
  id!: string;

  @ApiProperty({ enum: ['CHECKING', 'SAVINGS'], example: 'CHECKING' })
  type!: 'CHECKING' | 'SAVINGS';

  @ApiProperty({ enum: ['ACTIVE', 'LOCKED'], example: 'LOCKED' })
  status!: 'ACTIVE' | 'LOCKED';

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-11-08T05:10:00.123Z',
  })
  updatedAt!: string;
}

export function parseAccountUuid(rawId: string): string {
  if (typeof rawId !== 'string') invalid('id must be a valid UUID');
  const trimmed = rawId.trim();
  if (!UUID_PATTERN.test(trimmed)) invalid('id must be a valid UUID');
  return trimmed.toLowerCase();
}

export function parseStatusReason(rawBody: unknown): string {
  if (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    invalid('request body must be a JSON object');
  }
  const body = rawBody as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.some(key => key !== 'reason')) {
    invalid('unknown property in request body');
  }
  if (typeof body.reason !== 'string') {
    invalid('reason is required and must be a string');
  }
  if (LONE_SURROGATE_PATTERN.test(body.reason)) {
    invalid('reason must not contain lone UTF-16 surrogates');
  }
  const normalized = body.reason.normalize('NFC').trim();
  const codePointLength = [...normalized].length;
  if (codePointLength < 1 || codePointLength > MAX_REASON_LENGTH) {
    invalid(`reason must contain 1 to ${MAX_REASON_LENGTH} characters`);
  }
  if (/\p{Cc}/u.test(normalized)) {
    invalid('reason must not contain control characters');
  }
  return normalized;
}

/**
 * 32 hex chars of SHA-256 over the exact NFC+trimmed reason string (preserving case).
 * Prevents raw free-text PII from entering `audit_log.metadata` while letting an auditor
 * verify a reason string against the audit record (`audit-metadata.guard.ts`).
 */
export function fingerprintReason(normalizedReason: string): string {
  return createHash('sha256').update(normalizedReason, 'utf8').digest('hex').slice(0, 32);
}

export function resolveLockReason(normalizedReason: string): AuditReason {
  return KNOWN_LOCK_REASONS.get(normalizedReason) ?? AuditReason.OPERATOR_LOCK;
}

export function resolveUnlockReason(normalizedReason: string): AuditReason {
  return KNOWN_UNLOCK_REASONS.get(normalizedReason) ?? AuditReason.OPERATOR_UNLOCK;
}

