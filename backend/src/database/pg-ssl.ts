import { readFileSync } from 'node:fs';

export interface PgSslSettings {
  enabled: boolean;
  /** Path of a PEM file with the CA that signed the server certificate (e.g. the RDS bundle). */
  caPath?: string;
}

export type PgSsl = false | { rejectUnauthorized: true; ca?: string };

/**
 * TLS settings for the PostgreSQL connection.
 *
 * The server certificate is ALWAYS verified. Node does not trust the Amazon RDS CA by default, so
 * connecting to RDS needs its CA bundle via `caPath`; turning verification off to get past the
 * resulting error would keep the traffic encrypted but accept any certificate, including an
 * attacker's. An unreadable CA file stops the process at start-up, naming the variable and path.
 */
export function buildSslOptions(
  settings: PgSslSettings,
  readFile: (path: string) => string = path => readFileSync(path, 'utf8'),
): PgSsl {
  if (!settings.enabled) return false;
  if (!settings.caPath) return { rejectUnauthorized: true };
  try {
    return { rejectUnauthorized: true, ca: readFile(settings.caPath) };
  } catch (error) {
    throw new Error(
      `DATABASE_SSL_CA_PATH points to an unreadable file (${settings.caPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
