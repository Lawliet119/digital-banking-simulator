import { getContainerRuntimeClient } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const ENV_FILE_PATH = path.resolve(__dirname, '../../.testcontainers-db.env');
export const STARTUP_TIMEOUT_MS = 60_000;

export interface StartedPostgres {
  databaseUrl: string;
  container: StartedPostgreSqlContainer;
  stop(): Promise<void>;
}

let activeContainer: StartedPostgreSqlContainer | null = null;

/**
 * Checks whether Docker runtime is available and reachable.
 * Throws a clear, actionable error if Docker is down to fail-fast within seconds.
 */
export async function assertDockerAvailable(
  clientGetter: () => Promise<unknown> = getContainerRuntimeClient,
): Promise<void> {
  try {
    await clientGetter();
  } catch (error) {
    throw new Error(
      '[Testcontainers] Docker is not running or unreachable. Please start Docker Desktop to run database tests. ' +
        `Error details: ${(error as Error).message}`,
    );
  }
}

/**
 * Starts a PostgreSQL 17 Alpine container configured with UTC timezone.
 * Enforces startup timeout <= 60 seconds (DoD #4).
 */
export async function startPostgresContainer(): Promise<StartedPostgres> {
  await assertDockerAvailable();

  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withEnvironment({ TZ: 'UTC' })
    .withCommand(['postgres', '-c', 'timezone=UTC'])
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();

  activeContainer = container;
  const databaseUrl = container.getConnectionUri();

  // Persist connection URI to temp env file so Jest test workers can read it
  fs.writeFileSync(ENV_FILE_PATH, `DATABASE_URL=${databaseUrl}\n`, 'utf-8');
  process.env.DATABASE_URL = databaseUrl;

  return {
    databaseUrl,
    container,
    async stop() {
      await stopPostgresContainer();
    },
  };
}

/**
 * Stops the running PostgreSQL container and removes the temporary env file.
 */
export async function stopPostgresContainer(): Promise<void> {
  if (activeContainer) {
    try {
      await activeContainer.stop();
    } finally {
      activeContainer = null;
    }
  }

  if (fs.existsSync(ENV_FILE_PATH)) {
    try {
      fs.unlinkSync(ENV_FILE_PATH);
    } catch {
      // Ignore cleanup error if already removed
    }
  }
}

/**
 * Reads the DATABASE_URL from .testcontainers-db.env or process.env.
 */
export function getPostgresContainerUrl(): string | undefined {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  if (fs.existsSync(ENV_FILE_PATH)) {
    const content = fs.readFileSync(ENV_FILE_PATH, 'utf-8');
    const match = content.match(/^DATABASE_URL=(.+)$/m);
    if (match?.[1]) {
      process.env.DATABASE_URL = match[1].trim();
      return process.env.DATABASE_URL;
    }
  }
  return undefined;
}
