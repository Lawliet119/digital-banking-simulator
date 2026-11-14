import type { AuditTargetType } from './audit.registry';
import { AuditTargetError, type AuditTarget } from './audit.types';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_INT4 = 2_147_483_647;

/**
 * What `audit_log.target_id` may hold for each `target_type` (BL-019). The column is open `text`
 * (database-design §4.7: the id of an account that does not exist is a legal target), so this is
 * the only place that says what an id looks like. A value that fits no format is a caller bug,
 * usually a request value that reached the log unvalidated (PII or an injection string).
 */
const TARGET_ID_FORMATS: Record<AuditTargetType, (id: string) => boolean> = {
  /** `AccountsService.getOwnedAccount` writes the literal `invalid` for a path value that is not a UUID. */
  account: id => UUID.test(id) || id === 'invalid',
  customer: id => UUID.test(id),
  fraud_flag: id => UUID.test(id),
  transfer: id => UUID.test(id),
  user: id => UUID.test(id),
  /** `fingerprintTerm`: 32 hex characters of SHA-256, never the searched name. */
  account_search: id => /^[0-9a-f]{32}$/.test(id),
  /** The server-made request code (`correlationIdMiddleware` uses `randomUUID`). */
  audit_search: id => UUID.test(id),
  fraud_flag_search: id => UUID.test(id),
  /** `risk_rule_sets.version`, a PostgreSQL integer. */
  risk_rule_set: id => /^[1-9][0-9]{0,9}$/.test(id) && Number(id) <= MAX_INT4,
  /** `<METHOD> <route template>`; `(unknown route)` when Express set no route. Never a URL with a query. */
  route: id => /^[A-Z]{3,7} [^\s?][^?\r\n]{0,254}$/.test(id),
};

/**
 * Runtime backstop for the target id, next to `assertValidMetadata`: the compile-time type of
 * `AuditTarget.id` is `string`, so a variable or a cast reaches the log unless this runs. Throws
 * `AuditTargetError`, whose message never echoes the rejected value.
 */
export function assertValidTarget(target: AuditTarget): void {
  const type = typeof target?.type === 'string' ? target.type : '';
  if (!Object.hasOwn(TARGET_ID_FORMATS, type)) throw new AuditTargetError();
  if (typeof target.id !== 'string' || !TARGET_ID_FORMATS[type as AuditTargetType](target.id)) {
    throw new AuditTargetError();
  }
}
