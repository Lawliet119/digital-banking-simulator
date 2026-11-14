import { writeSync } from 'node:fs';

/**
 * For the one stretch where no logger exists yet: the synchronous top level of `env.bootstrap`
 * runs before `process-logging.bootstrap` builds it (BL-026). An error thrown there would reach
 * Node's text crash printer, stack trace included. This writes one fixed `fatal` JSON line
 * straight to stdout instead (no pino, no message, no stack: the error text may quote a path or a
 * value from the environment) and the caller then exits. Total: it never throws.
 */
export function writeBootstrapFatal(message: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const appRole = (env.APP_ROLE ?? 'both').trim().toLowerCase();
    const record = {
      level: 60,
      time: new Date().toISOString(),
      appRole: ['api', 'worker', 'both'].includes(appRole) ? appRole : 'both',
      role: appRole === 'worker' ? 'worker' : 'api',
      correlationId: null,
      message,
    };
    writeSync(1, `${JSON.stringify(record)}\n`);
  } catch {
    /* stdout closed or full: nothing left to write to */
  }
}
