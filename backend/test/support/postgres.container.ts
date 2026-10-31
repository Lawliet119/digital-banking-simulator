import { getContainerRuntimeClient } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export const STARTUP_TIMEOUT_MS = 60_000;
/** Longest the whole `start()` may take, image pull included; STARTUP_TIMEOUT_MS only covers readiness. */
export const OVERALL_START_TIMEOUT_MS = 300_000;
/** Longest we wait for the Docker daemon to answer before giving up. */
export const DOCKER_CHECK_TIMEOUT_MS = 15_000;

/**
 * Rejects with `message` if `work` has not settled within `ms`. The timer is always cleared so it
 * never keeps the Jest process alive.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

export interface StartedPostgres {
  databaseUrl: string;
}

/**
 * Checks whether Docker runtime is available and reachable.
 * Throws a clear, actionable error if Docker is down to fail-fast within seconds.
 */
export async function assertDockerAvailable(
  clientGetter: () => Promise<unknown> = getContainerRuntimeClient,
  contextLabel: string = 'database tests',
): Promise<void> {
  try {
    await withTimeout(
      clientGetter(),
      DOCKER_CHECK_TIMEOUT_MS,
      `Docker daemon did not respond within ${DOCKER_CHECK_TIMEOUT_MS / 1000}s`,
    );
  } catch (error) {
    throw new Error(
      `[Testcontainers] Docker is not running or unreachable. Please start Docker Desktop to run ${contextLabel}. ` +
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

  const starting = new PostgreSqlContainer('postgres:17-alpine')
    .withEnvironment({ TZ: 'UTC' })
    .withCommand(['postgres', '-c', 'timezone=UTC'])
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();

  let container: StartedPostgreSqlContainer;
  try {
    container = await withTimeout(
      starting,
      OVERALL_START_TIMEOUT_MS,
      `[Testcontainers] PostgreSQL did not become ready within ${OVERALL_START_TIMEOUT_MS / 1000}s ` +
        '(including the image pull of postgres:17-alpine). Check your network, or run ' +
        '`docker pull postgres:17-alpine` first and retry.',
    );
  } catch (error) {
    // Jest skips globalTeardown when globalSetup throws, so a start() that only finishes after we
    // gave up would leak its container. Ryuk is the main cleanup; this is the fallback while the
    // process is still alive.
    void starting.then(late => late.stop()).catch(() => undefined);
    throw error;
  }

  // Held on globalThis (shared by Jest's globalSetup and globalTeardown); globalSetup alone
  // decides what to do with the URL, this function never touches process.env.
  (
    globalThis as unknown as { __POSTGRES_CONTAINER__?: StartedPostgreSqlContainer }
  ).__POSTGRES_CONTAINER__ = container;

  return { databaseUrl: container.getConnectionUri() };
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
