import type { RequestHandler, Request } from 'express';
import type { HttpStats } from './http-stats';

/**
 * The route template Express matched. It is read when the answer is done, because the route is set
 * while the request is being handled. `originalUrl` is never read: it holds ids.
 */
function routeOf(req: Request): unknown {
  const path: unknown = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof path !== 'string') return undefined;
  return `${typeof req.baseUrl === 'string' ? req.baseUrl : ''}${path}`;
}

/**
 * Times every request from the moment it is mounted (right after the correlation id, before CORS
 * and body parsing) to the end of its answer. `finish` is a request that was answered; `close`
 * without a finished answer is a client or a load balancer that gave up. A request is recorded
 * once, whichever of the two comes first, and a failure here never reaches the request.
 */
export function createHttpMetricsMiddleware(stats: HttpStats): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    let recorded = false;
    const done = (aborted: boolean): void => {
      if (recorded) return;
      recorded = true;
      try {
        stats.record({
          route: routeOf(req),
          method: req.method,
          status: aborted ? undefined : res.statusCode,
          durationMs: Number(process.hrtime.bigint() - start) / 1e6,
          aborted,
        });
      } catch {
        // Measuring must never change what a request does.
      }
    };
    res.on('finish', () => done(false));
    res.on('close', () => done(!res.writableFinished));
    next();
  };
}
