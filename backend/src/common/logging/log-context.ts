import { PinoLogger } from 'nestjs-pino';

/**
 * The one way to give a piece of work its logging context (DBS-43, BL-024). Every entrypoint that
 * starts work outside the request pipeline, and the HTTP middleware itself, goes through
 * `runInLogContext`: it binds `role` and `correlationId` once, from validated values, in an
 * AsyncLocalStorage store that follows the work across every `await`, so the logs of parallel
 * requests or messages never mix.
 *
 * Sensitive data has no way in: the only two things a context carries are a fixed role and a
 * UUID. Bindings added later by other code (`PinoLogger.assign`, `logger.child`) are reduced by the
 * `onChild` hook of `createLoggingOptions`, which keeps the first role and correlationId and masks
 * sensitive keys, so a context is never rebound and a key never appears twice.
 */
export type LogRole = 'api' | 'worker';

export interface LogContextInput {
  role: LogRole;
  /** A UUID, or nothing (a background task has no request). Anything else is stored as `null`. */
  correlationId?: string | null;
}

export interface LogContext {
  role: LogRole;
  correlationId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Total on purpose: logging sits on error paths, so a bad id becomes `null` and an unknown role
 * `api`, never an exception.
 */
export function bindLogContext(input: LogContextInput): LogContext {
  return {
    role: input.role === 'worker' ? 'worker' : 'api',
    correlationId: isCorrelationId(input.correlationId) ? input.correlationId : null,
  };
}

/**
 * Runs `fn` in a fresh context made from the root logger (never from the surrounding one, so a job
 * started inside a request does not inherit its id). Returns whatever `fn` returns. Without a
 * logger (a unit test of a service) `fn` simply runs.
 */
export function runInLogContext<T>(fn: () => T, input: LogContextInput): T {
  if (!(PinoLogger as { root?: unknown }).root) return fn();
  // `runInContext` reads no instance state (it uses the library's own store and root logger), so
  // it is called once, here, without needing an injected PinoLogger at every entrypoint.
  return PinoLogger.prototype.runInContext.call(PinoLogger.prototype, fn, {
    bindings: bindLogContext(input),
  }) as T;
}

/**
 * A background task (polling loop, scheduler) in any APP_ROLE: its lines say `role=worker` even in
 * a `both` process, where outside a context the default role is `api`.
 */
export function runAsWorker<T>(fn: () => T): T {
  return runInLogContext(fn, { role: 'worker', correlationId: null });
}
