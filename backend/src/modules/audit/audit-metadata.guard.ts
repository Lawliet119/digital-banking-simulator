import { ErrorCode } from '@common/errors/error-code.enum';
import { AuditMetadataError, AuditReason, type AuditMetadata } from './audit.types';

const ALLOWED_KEYS = new Set(['id', 'reason', 'count']);
const ID_PATTERN = /^[0-9a-fA-F-]{1,36}$/;
const VALID_REASONS: ReadonlySet<string> = new Set([
  ...Object.values(ErrorCode),
  ...Object.values(AuditReason),
]);

/**
 * Compile-time excess-property checks only reject fresh object literals (TC-56-07); a variable,
 * a spread or an `as` cast bypasses them (TC-56-07b). This is the runtime backstop DoD #4 needs.
 * Throws `AuditMetadataError` — a fixed message that never echoes the rejected value, so the
 * PII this guard exists to block never re-leaks through the error it raises.
 */
export function assertValidMetadata(metadata: AuditMetadata | undefined): void {
  if (metadata === undefined) return;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new AuditMetadataError();
  }
  for (const key of Object.keys(metadata)) {
    if (!ALLOWED_KEYS.has(key)) throw new AuditMetadataError();
  }
  if (
    metadata.id !== undefined &&
    (typeof metadata.id !== 'string' || !ID_PATTERN.test(metadata.id))
  ) {
    throw new AuditMetadataError();
  }
  if (
    metadata.reason !== undefined &&
    (typeof metadata.reason !== 'string' || !VALID_REASONS.has(metadata.reason))
  ) {
    throw new AuditMetadataError();
  }
  if (
    metadata.count !== undefined &&
    !(Number.isSafeInteger(metadata.count) && metadata.count >= 0)
  ) {
    throw new AuditMetadataError();
  }
}
