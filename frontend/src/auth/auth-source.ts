export const ROLES = ['customer', 'operator', 'auditor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface SignInRequest {
  role: Role;
  /** The subject of the token: one person. */
  sub: string;
}

/** What every source does; the screens behind sign-in only see this part. */
interface Session {
  /** A session to resume exists in this tab (checked once, at start). */
  hasSession(): boolean;
  /** The access token to send, refreshed when the source can; null when there is none. */
  getToken(): Promise<string | null>;
  signOut(): Promise<void>;
  /** A name to show for the signed-in person, or null to show the subject. */
  userLabel(): Promise<string | null>;
}

/** Tokens signed on a developer machine by the Vite dev server. */
export interface LocalSource extends Session {
  kind: 'local';
  signIn(request: SignInRequest): Promise<void>;
}

/** Where a cloud sign-in goes next. */
export type CloudStep = 'done' | 'new-password' | 'confirm-sign-up' | 'reset-password';

/** The user pool: email and password, codes sent by email. */
export interface CloudSource extends Session {
  kind: 'cloud';
  signIn(email: string, password: string): Promise<CloudStep>;
  /** The first sign-in of an account an administrator created asks for a new password. */
  confirmNewPassword(password: string): Promise<CloudStep>;
  signUp(email: string, password: string): Promise<CloudStep>;
  confirmSignUp(email: string, code: string): Promise<void>;
  resendSignUpCode(email: string): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  confirmForgotPassword(email: string, code: string, password: string): Promise<void>;
}

/** A build without `/config.json`: nobody can sign in. */
export interface NoSource extends Session {
  kind: 'none';
}

export type AuthSource = LocalSource | CloudSource | NoSource;

export const NO_SOURCE: NoSource = {
  kind: 'none',
  hasSession: () => false,
  getToken: () => Promise.resolve(null),
  signOut: () => Promise.resolve(),
  userLabel: () => Promise.resolve(null),
};

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
