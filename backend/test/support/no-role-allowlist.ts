/**
 * Routes of the real app that deliberately have neither @Public() nor @Roles(), with the reason.
 * Shared by the role guard test (TC-51-27) and the OpenAPI completeness test (DBS-137), which both
 * need "any signed-in role" to mean the same routes. The two public health routes do NOT belong
 * here: they are @Public(), so `undeclaredRoutes()` never lists them.
 */
export const NO_ROLE_ALLOWLIST: Record<string, string> = {
  'GET /v1/identity/me': 'DBS-50 smoke endpoint: any valid token, whatever its role',
};
