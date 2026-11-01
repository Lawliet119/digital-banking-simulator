/**
 * The four application roles. They are the names of the Cognito groups Terraform creates
 * (infra/terraform/envs/dev/base/cognito.tf); nothing is stored in the database
 * (database-design §13 point 15). The order is the order `rolesFromGroups` returns them in.
 */
export const ROLES = ['customer', 'operator', 'auditor', 'admin'] as const;

export type Role = (typeof ROLES)[number];

/**
 * Derives the caller's roles from the `cognito:groups` claim of a token that JwtAuthGuard has
 * already verified. This is the only place a role is ever decided (DBS-51).
 *
 * `groups` is `unknown` on purpose: JwtAuthGuard types it as `string[]` but only replaces a
 * missing claim with `[]`, so a signed token carrying a string or an object reaches here as is.
 * The check is `Array.isArray`, then `typeof === 'string'`, then an exact `ROLES.includes` —
 * never a lookup by object key or a loop over `length`, which would let an array-like object or
 * a name such as `__proto__` through.
 *
 * - No group, or nothing valid, is `customer` (ADR-06). The result is never empty.
 * - There is no hierarchy: `admin` does not imply `operator`.
 * - Matching is exact: no trimming and no case folding.
 */
export function rolesFromGroups(groups: unknown): Role[] {
  const present = new Set<string>();
  if (Array.isArray(groups)) {
    for (const group of groups as unknown[]) {
      if (typeof group === 'string') present.add(group);
    }
  }
  const roles = ROLES.filter(role => present.has(role));
  return roles.length > 0 ? roles : ['customer'];
}
