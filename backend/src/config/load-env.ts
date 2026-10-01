import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

/**
 * Loads `env/.env.<NODE_ENV>` (relative to the working directory, i.e. `backend/`) into
 * `process.env`. Variables that already exist win: on ECS the platform injects the real
 * environment and no file is present at all.
 *
 * Returns the file that was loaded, or undefined when there was none.
 */
export function loadEnv(
  nodeEnv: string = process.env.NODE_ENV ?? 'development',
): string | undefined {
  const file = resolve(process.cwd(), 'env', `.env.${nodeEnv}`);
  if (!existsSync(file)) return undefined;
  config({ path: file, quiet: true });
  return file;
}
