/**
 * Process role of this instance. The same image is deployed as two ECS services:
 *  - `api`    → serves HTTP only; runs NO background consumers or schedulers.
 *  - `worker` → runs outbox relay, risk scoring, notification only; binds NO HTTP port.
 *  - `both`   → does everything in one process. Default; use for local dev and tests.
 *
 * Producers (writing an outbox row, publishing a message) happen inside a request, so they
 * work in every role. Only consumers and schedulers are gated by `runsWorkers`.
 *
 * Controlled by the `APP_ROLE` env var. The Joi schema validates it at boot; this module
 * additionally throws on an invalid value so a typo can never silently become `both`.
 */
export enum AppRole {
  Api = 'api',
  Worker = 'worker',
  Both = 'both',
}

const VALID_ROLES: readonly string[] = Object.values(AppRole);

export function parseAppRole(raw: string | undefined): AppRole {
  const value = (raw ?? AppRole.Both).trim().toLowerCase();
  if (!VALID_ROLES.includes(value)) {
    throw new Error(`Invalid APP_ROLE "${raw}" — expected one of: ${VALID_ROLES.join(', ')}`);
  }
  return value as AppRole;
}

export function getAppRole(env: NodeJS.ProcessEnv = process.env): AppRole {
  return parseAppRole(env.APP_ROLE);
}

/** True when this process should serve HTTP (`api` or `both`). */
export function runsHttp(role: AppRole = getAppRole()): boolean {
  return role === AppRole.Api || role === AppRole.Both;
}

/** True when this process should run consumers and schedulers (`worker` or `both`). */
export function runsWorkers(role: AppRole = getAppRole()): boolean {
  return role === AppRole.Worker || role === AppRole.Both;
}
