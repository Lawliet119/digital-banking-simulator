import type { Role } from './roles';

/** What `RolesGuard` knows about a refusal. Nothing here comes from a header, body or query. */
export interface RoleDenial {
  /** `users.id` of the caller (the guard only reaches this point with an authenticated user). */
  readonly userId: string;
  /** The roles `rolesFromGroups` derived. Never empty (no group means `customer`, ADR-06). */
  readonly roles: readonly Role[];
  /** HTTP verb. */
  readonly method: string;
  /** The route template (`/v1/operator/deposits`), never the URL: a query string can carry anything. */
  readonly route: string;
  /** Server-generated request code (`correlationIdMiddleware`). */
  readonly correlationId: string;
}

/**
 * The port `RolesGuard` writes its audit `DENIED` record through (BL-132, FR-AUD-02). It lives in
 * `identity` and `AuditModule` provides the implementation, so the guard never imports the audit
 * module: `audit.controller` already imports `@modules/identity`, and the reverse import would be
 * a load-order cycle. An abstract class, not an interface, because Nest needs a runtime token.
 *
 * An implementation must write in its own transaction (the 403 has no business transaction to
 * join) and must reject when it cannot write: the guard lets that error escape, so a refusal that
 * left no evidence is never reported as a clean 403.
 */
export abstract class RoleDenialAudit {
  abstract recordRoleDenied(denial: RoleDenial): Promise<void>;
}
