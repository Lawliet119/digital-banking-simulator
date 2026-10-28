import { getContainerRuntimeClient, type StartedTestContainer } from 'testcontainers';
import { OVERALL_START_TIMEOUT_MS, withTimeout } from './postgres.container';

export interface ControlledService {
  containerId: string;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

export interface StartedServiceContainer<T> {
  container: StartedTestContainer;
  probeResult: T;
}

/**
 * Starts `starting`, then runs `probe` against the result. `probeTimeoutMs` is the protocol
 * probe's own budget (default 30s); it is independent of `OVERALL_START_TIMEOUT_MS`, which only
 * covers the container reaching a running state. Callers whose probe needs longer (bounded
 * retries over a slow protocol) pass a larger `probeTimeoutMs` explicitly.
 *
 * If the probe does not settle within `probeTimeoutMs`, the `AbortSignal` passed to it is
 * aborted before the container is stopped, so a probe that checks the signal (or forwards it to
 * an SDK call) stops its own in-flight work instead of continuing to run against a container that
 * is being removed.
 */
export async function startServiceContainer<T>(
  name: string,
  starting: Promise<StartedTestContainer>,
  probe: (container: StartedTestContainer, signal: AbortSignal) => Promise<T>,
  probeTimeoutMs = 30_000,
): Promise<StartedServiceContainer<T>> {
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
  const controller = new AbortController();
  try {
    const probeResult = await withTimeout(
      probe(container, controller.signal),
      probeTimeoutMs,
      `[Testcontainers] ${name} protocol probe timed out`,
    );
    return { container, probeResult };
  } catch (error) {
    controller.abort();
    await container.stop();
    throw error;
  }
}

/**
 * Resolves to `true` if `pending` is still unsettled after `ms`, `false` if it resolves **or
 * rejects** before then. Never throws: a rejection of `pending` is caught internally, so a caller
 * racing a probe against a pause/down scenario gets a plain boolean instead of risking an
 * unhandled rejection when the probe errors (connection reset) rather than hanging.
 */
export function stillPendingAfter(pending: Promise<unknown>, ms: number): Promise<boolean> {
  const settled = pending.then(
    () => false,
    () => false,
  );
  const timedOut = new Promise<boolean>(resolve => setTimeout(() => resolve(true), ms));
  return Promise.race([settled, timedOut]);
}

export function controlService(container: StartedTestContainer): ControlledService {
  let paused = false;
  let stopped = false;

  const resolveDockerContainer = async () => {
    const runtime = await getContainerRuntimeClient();
    return runtime.container.getById(container.getId());
  };
  // Memoized: pause()/resume()/stop() share one lookup instead of hitting the Docker runtime
  // client again on every call.
  let dockerContainerPromise: ReturnType<typeof resolveDockerContainer> | undefined;
  const dockerContainer = () => {
    if (dockerContainerPromise === undefined) {
      dockerContainerPromise = resolveDockerContainer();
    }
    return dockerContainerPromise;
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
