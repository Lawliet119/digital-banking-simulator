import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension, ApiForbiddenResponse } from '@nestjs/swagger';
import { ROLES, type Role } from './roles';

/** Metadata key `@Roles` writes and `RolesGuard` reads. */
export const ROLES_KEY = 'dbs:roles';

/**
 * Declares which roles may call a route (or every route of a controller). A caller passes when
 * at least one of its roles is listed; there is no hierarchy, so a route for both staff and
 * admins is `@Roles('operator', 'admin')`. A `@Roles` on a method replaces the one on its class.
 *
 * A route with no `@Roles` needs only a valid token (decision G1 of DBS-51): remembering to add
 * this is the developer's job, and a test fails when a route has neither this nor `@Public()`.
 *
 * The list is checked here, at declaration time, so a typo stops the app at boot instead of
 * becoming a route that nobody (or everybody) can reach.
 */
export function Roles(...roles: [Role, ...Role[]]): ClassDecorator & MethodDecorator {
  if (roles.length === 0) {
    throw new Error('@Roles needs at least one role');
  }
  for (const role of roles) {
    if (!ROLES.includes(role)) {
      throw new Error(`@Roles got "${String(role)}", which is not one of: ${ROLES.join(', ')}`);
    }
  }
  const allowed: Role[] = [...roles];
  return applyDecorators(
    SetMetadata(ROLES_KEY, allowed),
    ApiExtension('x-roles', allowed),
    ApiForbiddenResponse({
      description: 'The caller has none of the allowed roles (errorCode FORBIDDEN)',
    }),
  );
}
