import type { INestApplication } from '@nestjs/common';
import { ShutdownSignal } from '@nestjs/common';
import type { Server } from 'node:http';
import { safeErrorMetadata } from '@common/logging/logging.options';
import type { InflightRequests } from './inflight-requests';

/** The signals that stop a task (`docker stop`, ECS) or a developer's terminal. */
export const DRAIN_SIGNALS: readonly ShutdownSignal[] = [
  ShutdownSignal.SIGTERM,
  ShutdownSignal.SIGINT,
];

/** How often connections that finished their request are closed while draining. */
const IDLE_SWEEP_MS = 100;

export interface ShutdownLogger {
  log(message: unknown, ...rest: unknown[]): void;
  warn(message: unknown, ...rest: unknown[]): void;
  error(message: unknown, ...rest: unknown[]): void;
}

/**
 * Stops accepting connections, then waits until every connection is closed and every handler is
 * done, at most `timeoutMs`. What is still open after that is cut. Returns the number of handlers
 * abandoned.
 */
export async function drainHttp(
  server: Server,
  requests: InflightRequests,
  timeoutMs: number,
): Promise<number> {
  requests.startDraining();
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  // `close()` ends the connections idle at this instant only. One that is busy now becomes idle
  // after its answer and would be kept for `keepAliveTimeout` (65 s), past the ECS stop timeout.
  const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const first = await Promise.race([Promise.all([closed, requests.idle()]), limit]);
    if (first !== 'timeout') return 0;
    const abandoned = requests.count;
    server.closeAllConnections();
    return abandoned;
  } finally {
    clearInterval(sweep);
    clearTimeout(timer);
  }
}

export interface GracefulShutdownOptions {
  requests: InflightRequests;
  drainTimeoutMs: number;
  logger: ShutdownLogger;
}

/**
 * Replaces `enableShutdownHooks()` for a process that serves HTTP (BL-381). On SIGTERM or SIGINT
 * the running requests finish BEFORE `app.close()`: Nest runs `onModuleDestroy` (Redis) before it
 * closes the server, and TypeORM's close releases the query runner of a request still running. The
 * other signals keep Nest's own handling. The process ends with `process.exit` (BL-384).
 */
export function enableGracefulShutdown(
  app: INestApplication,
  options: GracefulShutdownOptions,
): void {
  const { requests, drainTimeoutMs, logger } = options;
  app.enableShutdownHooks(
    Object.values(ShutdownSignal).filter(signal => !DRAIN_SIGNALS.includes(signal)),
    { useProcessExit: true },
  );

  let stopping = false;
  const stop = async (signal: ShutdownSignal): Promise<void> => {
    // A second signal while draining changes nothing.
    if (stopping) return;
    stopping = true;
    try {
      logger.log({ signal, running: requests.count }, 'Shutting down', 'Shutdown');
      const abandoned = await drainHttp(app.getHttpServer() as Server, requests, drainTimeoutMs);
      if (abandoned > 0) {
        logger.warn(
          { abandoned, drainTimeoutMs },
          'Requests still running at the drain limit',
          'Shutdown',
        );
      }
      await app.close();
      process.exit(0);
    } catch (error) {
      logger.error(safeErrorMetadata(error), 'Application shutdown failed', 'Shutdown');
      process.exit(1);
    }
  };
  for (const signal of DRAIN_SIGNALS) process.on(signal, () => void stop(signal));
}
