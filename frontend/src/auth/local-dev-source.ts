import type { AuthSource, SignInRequest } from './auth-source';

const KEY = 'dbs.token';

/**
 * Tokens signed on this machine by the Vite dev server (`/__dev-auth/token`, which runs the
 * backend's `auth:dev-token`). Works only under `npm run dev` with the backend on
 * `AUTH_MODE=local`. The token is kept in memory and in sessionStorage (one tab, gone when the
 * tab closes); never in localStorage.
 */
export class LocalDevSource implements AuthSource {
  private token: string | null = sessionStorage.getItem(KEY);

  getToken(): Promise<string | null> {
    return Promise.resolve(this.token);
  }

  async signIn({ role, sub }: SignInRequest): Promise<void> {
    const query = new URLSearchParams({ role, sub });
    const response = await fetch(`/__dev-auth/token?${query.toString()}`, { cache: 'no-store' });
    const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!response.ok || !body.token) {
      throw new Error(body.error ?? `Không lấy được token (HTTP ${response.status}).`);
    }
    this.token = body.token;
    sessionStorage.setItem(KEY, body.token);
  }

  signOut(): Promise<void> {
    this.token = null;
    sessionStorage.removeItem(KEY);
    return Promise.resolve();
  }
}
