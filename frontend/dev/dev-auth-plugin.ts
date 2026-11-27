import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/** The four roles `npm run auth:dev-token` signs. Anything else is refused before a process starts. */
export const DEV_ROLES = ['customer', 'operator', 'auditor', 'admin'] as const;
export type DevRole = (typeof DEV_ROLES)[number];

const SUB = /^[A-Za-z0-9-]{1,64}$/;

export type DevTokenRequest = { role: DevRole; sub: string } | { error: string };

/** Reads and checks `?role=&sub=`. Pure, so the rules are tested without a server. */
export function parseDevTokenQuery(search: URLSearchParams): DevTokenRequest {
  const keys = [...search.keys()];
  if (keys.some(key => key !== 'role' && key !== 'sub')) return { error: 'unknown parameter' };
  if (search.getAll('role').length !== 1 || search.getAll('sub').length !== 1) {
    return { error: 'role and sub are each required once' };
  }
  const role = search.get('role') ?? '';
  const sub = search.get('sub') ?? '';
  if (!(DEV_ROLES as readonly string[]).includes(role)) return { error: 'unknown role' };
  if (!SUB.test(sub)) return { error: 'sub must match ^[A-Za-z0-9-]{1,64}$' };
  return { role: role as DevRole, sub };
}

/**
 * Arguments of the token CLI, run with the current Node directly (no shell, no `npm.cmd`): every
 * value is one array element, never part of a command string.
 */
export function tokenCommand(role: DevRole, sub: string): string[] {
  return [
    '-r',
    'ts-node/register',
    '-r',
    'tsconfig-paths/register',
    'src/scripts/dev-auth.token.ts',
    '--role',
    role,
    '--sub',
    sub,
  ];
}

/**
 * `GET /__dev-auth/token?role=<role>&sub=<id>`: a local access token signed with the key of
 * `backend/.auth-local` (the backend runs with `AUTH_MODE=local`). Only `vite dev` serves it
 * (`apply: 'serve'`); a production build has no such route.
 */
export function devAuthPlugin(backendDir = resolve(import.meta.dirname, '../../backend')): Plugin {
  return {
    name: 'dbs-dev-auth',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev-auth/token', (req, res) => {
        const reply = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'GET') return reply(405, { error: 'GET only' });
        const parsed = parseDevTokenQuery(new URL(req.url ?? '', 'http://local').searchParams);
        if ('error' in parsed) return reply(400, parsed);
        execFile(
          process.execPath,
          tokenCommand(parsed.role, parsed.sub),
          {
            cwd: backendDir,
            env: { ...process.env, NODE_ENV: 'development' },
            timeout: 60_000,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (error) {
              server.config.logger.error(`[dev-auth] token CLI failed: ${stderr.trim()}`);
              return reply(500, {
                error: 'token CLI failed: run `npm run auth:dev-keys` in backend/',
              });
            }
            reply(200, { token: stdout.trim() });
          },
        );
      });
    },
  };
}
