import { ROLES, type Role } from '@modules/identity';

/**
 * Closed registries for `audit_log.action`, `actor_role` and `target_type` (BL-019). They exist at
 * compile time only: the columns stay open `text` (database-design §4.7) and every string below is
 * a value some caller already stores, so adding a registry changed no row. A typo in a caller now
 * fails `tsc` instead of splitting one action over two spellings in the audit search.
 *
 * To add an action, role or target type, add it here first, then to the doc of the module that
 * writes it (docs/components/audit/01-concept-brief.md lists them with the caller). Do not widen a
 * type to `string` to make a caller compile.
 */

/**
 * Every `audit_log.action` the code writes. Past-tense and noun forms already differ across
 * modules (`transfer` is written on success, `ledger.transfer` on a DENIED source check): that is
 * stored history, so the registry records it as is instead of renaming it.
 */
export const AUDIT_ACTIONS = [
  // Customer
  'account.open',
  'account.list',
  'account.read',
  'account.transactions',
  'customer.created',
  'customer.read',
  'transfer',
  'ledger.transfer',
  'transfer.read',
  // Operator
  'operator.account.search',
  'account.lock',
  'account.unlock',
  'deposit',
  'fraud_flag.search',
  'fraud_flag.view',
  'fraud_flag.review',
  // Auditor and admin
  'audit.search',
  'risk_config.create',
  // Workers (no logged-in user)
  'notification.sent',
  'fraud.flagged',
  // Any role: refused by RolesGuard (BL-132)
  'access.denied',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The four Cognito roles plus the worker, which acts with no logged-in user. */
export const AUDIT_ACTOR_ROLES = [...ROLES, 'worker'] as const;

/**
 * One role, or a comma-joined list in `ROLES` order for a caller that holds several groups (only
 * the role-denial row, which records every role the guard derived: `operator,auditor`).
 */
export type AuditActorRole = (typeof AUDIT_ACTOR_ROLES)[number] | `${Role},${string}`;

/** Every `audit_log.target_type` the code writes. `target.id` is a UUID or, for a search, a fingerprint or request code. */
export const AUDIT_TARGET_TYPES = [
  'account',
  'account_search',
  'audit_search',
  'customer',
  'fraud_flag',
  'fraud_flag_search',
  'risk_rule_set',
  /** `<METHOD> <route template>` of a request RolesGuard refused. Never a URL. */
  'route',
  'transfer',
  'user',
] as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/** Joins the derived roles for `actor_role`. `ROLES` order is kept, so the value is stable. */
export function actorRoleOf(roles: readonly Role[]): AuditActorRole {
  const [first, ...rest] = roles;
  if (first === undefined) {
    throw new Error('actorRoleOf needs at least one role');
  }
  return rest.length === 0 ? first : (`${first},${rest.join(',')}` as const);
}
