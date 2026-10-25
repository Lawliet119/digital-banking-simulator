export interface ComposedDatabaseUrl {
  url?: string;
  /** Names (never values) of the DB_* variables that are missing or malformed. */
  invalid: string[];
}

const HOST_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Builds `DATABASE_URL` from separate parts. ECS `secrets` can inject single JSON keys of a Secrets
 * Manager secret (the RDS master user and password) but cannot join them into a URL, so the task
 * passes DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD and the app assembles the URL.
 *
 * Pure: an existing non-empty DATABASE_URL always wins, nothing is configured without DB_HOST, and a
 * partial or malformed set yields no URL (config validation then reports the missing DATABASE_URL).
 * Only variable NAMES are reported, never values, so the password cannot reach a log.
 */
export function composeDatabaseUrl(env: NodeJS.ProcessEnv): ComposedDatabaseUrl {
  if (env.DATABASE_URL) return { invalid: [] };
  if (env.DB_HOST === undefined) return { invalid: [] };

  const { DB_HOST: host, DB_PORT: port, DB_NAME: name, DB_USER: user, DB_PASSWORD: password } = env;
  const invalid: string[] = [];
  if (!host || !HOST_PATTERN.test(host)) invalid.push('DB_HOST');
  if (!port || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    invalid.push('DB_PORT');
  }
  if (!name?.trim()) invalid.push('DB_NAME');
  if (!user?.trim()) invalid.push('DB_USER');
  if (!password) invalid.push('DB_PASSWORD');
  if (invalid.length > 0) return { invalid };

  return {
    url: `postgresql://${encodeURIComponent(user as string)}:${encodeURIComponent(
      password as string,
    )}@${host}:${port as string}/${encodeURIComponent(name as string)}`,
    invalid: [],
  };
}
