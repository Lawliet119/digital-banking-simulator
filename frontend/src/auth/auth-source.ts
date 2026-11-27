export const ROLES = ['customer', 'operator', 'auditor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface SignInRequest {
  role: Role;
  /** The subject of the token: one person. */
  sub: string;
}

/**
 * Where access tokens come from. The screens only see this interface, so the cloud round adds an
 * Identity Provider source without touching them. This round has one source: local dev tokens.
 */
export interface AuthSource {
  getToken(): Promise<string | null>;
  signIn(request: SignInRequest): Promise<void>;
  signOut(): Promise<void>;
}

/** Same rule as the server (`rolesFromGroups`): exact names, no group means customer. */
export function rolesFromGroups(groups: readonly unknown[] | undefined): Role[] {
  const present = new Set((groups ?? []).filter((g): g is string => typeof g === 'string'));
  const roles = ROLES.filter(role => present.has(role));
  return roles.length > 0 ? roles : ['customer'];
}

export const ROLE_LABELS: Record<Role, string> = {
  customer: 'Khách hàng',
  operator: 'Nhân viên',
  auditor: 'Kiểm toán viên',
  admin: 'Quản trị viên',
};

export const ROLE_HOME: Record<Role, string> = {
  customer: '/accounts',
  operator: '/operator/accounts',
  auditor: '/audit',
  admin: '/admin/risk-config',
};
