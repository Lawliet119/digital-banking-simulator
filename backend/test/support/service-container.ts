import { getContainerRuntimeClient, type StartedTestContainer } from 'testcontainers';
import {
  DOCKER_CHECK_TIMEOUT_MS,
  OVERALL_START_TIMEOUT_MS,
  withTimeout,
} from './postgres.container';

export interface ControlledService {
  containerId: string;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

export async function assertServiceDockerAvailable(): Promise<void> {
  try {
    await withTimeout(
      getContainerRuntimeClient(),
      DOCKER_CHECK_TIMEOUT_MS,
      'Docker daemon timed out',
    );
  } catch (error) {
    throw new Error(
      `[Testcontainers] Docker is not running or unreachable: ${(error as Error).message}`,
    );
  }
}

export async function startServiceContainer(
  name: string,
  starting: Promise<StartedTestContainer>,
  probe: (container: StartedTestContainer) => Promise<void>,
): Promise<StartedTestContainer> {
  let container: StartedTestContainer;
  try {
    container = await withTimeout(
      starting,
      OVERALL_START_TIMEOUT_MS,
      `[Testcontainers] ${name} did not start within ${OVERALL_START_TIMEOUT_MS / 1000}s`,
    );
  } catch (error) {
    void starting.then(late => late.stop()).catch(() => undefined);
    throw error;
  }
  try {
    await withTimeout(
      probe(container),
      30_000,
      `[Testcontainers] ${name} protocol probe timed out`,
    );
    return container;
  } catch (error) {
    await container.stop();
    throw error;
  }
}

export function controlService(container: StartedTestContainer): ControlledService {
  let paused = false;
  let stopped = false;
  const dockerContainer = async () => {
    const runtime = await getContainerRuntimeClient();
    return runtime.container.getById(container.getId());
  };
  return {
    containerId: container.getId(),
    async pause() {
      if (stopped) throw new Error('Cannot pause a stopped container');
      if (!paused) {
        await (await dockerContainer()).pause();
        paused = true;
      }
    },
    async resume() {
      if (paused && !stopped) {
        await (await dockerContainer()).unpause();
        paused = false;
      }
    },
    async stop() {
      if (stopped) return;
      try {
        if (paused) {
          try {
            await (await dockerContainer()).unpause();
          } catch {
            // Still try to remove the container if unpause failed during cleanup.
          }
        }
        await container.stop();
      } finally {
        stopped = true;
        paused = false;
      }
    },
  };
}
