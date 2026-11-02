export interface ComposedRedisUrl {
  url?: string;
  /** Names (never values) of the REDIS_* variables that are missing or malformed. */
  invalid: string[];
}

const HOST_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Builds `REDIS_URL` from separate parts. On ECS the AUTH token of ElastiCache comes from Secrets
 * Manager through `secrets`, which cannot join it into a URL, so the task passes REDIS_HOST,
 * REDIS_PORT and REDIS_AUTH_TOKEN and the app assembles the URL (DBS-75, same as composeDatabaseUrl).
 *
 * Always `rediss://`: this path only runs on AWS, where TLS is mandatory (NFR-SEC-03).
 * Pure: an existing non-empty REDIS_URL always wins, nothing is configured without REDIS_HOST, and a
 * partial or malformed set yields no URL (config validation then reports the missing REDIS_URL).
 * Only variable NAMES are reported, never values, so the token cannot reach a log.
 */
export function composeRedisUrl(env: NodeJS.ProcessEnv): ComposedRedisUrl {
  if (env.REDIS_URL) return { invalid: [] };
  if (env.REDIS_HOST === undefined) return { invalid: [] };

  const { REDIS_HOST: host, REDIS_PORT: port, REDIS_AUTH_TOKEN: token } = env;
  const invalid: string[] = [];
  if (!host || !HOST_PATTERN.test(host)) invalid.push('REDIS_HOST');
  if (!port || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    invalid.push('REDIS_PORT');
  }
  if (!token) invalid.push('REDIS_AUTH_TOKEN');
  if (invalid.length > 0) return { invalid };

  return {
    url: `rediss://:${encodeURIComponent(token as string)}@${host}:${port as string}`,
    invalid: [],
  };
}
