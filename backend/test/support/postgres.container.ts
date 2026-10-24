import { getContainerRuntimeClient } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export const STARTUP_TIMEOUT_MS = 60_000;

export interface StartedPostgres {
  databaseUrl: string;
  container: StartedPostgreSqlContainer;
  stop(): Promise<void>;
}

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

  (
    globalThis as unknown as { __POSTGRES_CONTAINER__?: StartedPostgreSqlContainer }
  ).__POSTGRES_CONTAINER__ = container;
  const databaseUrl = container.getConnectionUri();
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
 * Stops the running PostgreSQL container and clears DATABASE_URL.
 */
export async function stopPostgresContainer(): Promise<void> {
  const holder = globalThis as unknown as { __POSTGRES_CONTAINER__?: StartedPostgreSqlContainer };
  const container = holder.__POSTGRES_CONTAINER__;
  // No handle: this run started no container, so DATABASE_URL came from outside (CI, or exported
  // by the developer) and is not ours to clear — a watch re-run must keep using it.
  if (!container) {
    return;
  }

  try {
    await container.stop();
  } finally {
    delete holder.__POSTGRES_CONTAINER__;
    delete process.env.DATABASE_URL;
  }
}
