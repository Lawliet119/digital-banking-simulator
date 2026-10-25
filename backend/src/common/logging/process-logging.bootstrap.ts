import { writeSync } from 'node:fs';
import { PinoLogger } from 'nestjs-pino';
import pino from 'pino';
import { AppRole, getAppRole } from '../app-role/app-role';
import { createLoggingOptions, safeErrorMetadata } from './logging.options';

/**
 * Side-effect module: import it right after `env.bootstrap` in main.ts. It builds the one logger
 * the process uses from its first line, and registers the handlers that turn an error nobody
 * caught into a JSON `fatal` line instead of Node's text stack trace (which can carry SQL text).
 *
 * LOG_LEVEL and APP_ROLE are read raw here because this runs before ConfigModule exists; the
 * logger has to be there to report a bad configuration at all. A bad value falls back to the
 * defaults (`log`, `api`) and Joi rejects it right after.
 */
let role = AppRole.Api;
try {
  role = getAppRole();
} catch {
  /* main.ts reports an invalid APP_ROLE by key name, without echoing its value. */
}
const settings = { role, logLevel: process.env.LOG_LEVEL };

/** Asynchronous (Pino's default): a synchronous stdout would stall the event loop when it is full. */
const rootDestination = pino.destination({ dest: 1, sync: false });

/** Becomes the nestjs-pino root logger; the first one created wins, so nothing may precede it. */
export const bootstrapLogger = new PinoLogger({
  pinoHttp: [createLoggingOptions(settings), rootDestination],
});

/** Plain pino, so the "first one wins" rule above does not apply. Synchronous for the exit path. */
const crashLogger = pino(createLoggingOptions(settings), pino.destination({ dest: 1, sync: true }));

function logFatalAndExit(error: unknown, message: string): never {
  let flushed = true;
  try {
    // SonicBoom skips a write that is already in flight (it does not throw), so a line being
    // written right now can still be cut short by the exit; the README lists this limit. It
    // throws only when it cannot flush at all.
    rootDestination.flushSync();
  } catch {
    flushed = false;
  }
  if (!flushed) {
    try {
      // Whatever is buffered may be half written: start the fatal record on a line of its own.
      writeSync(1, '\n');
    } catch {
      /* stdout closed or full */
    }
  }
  try {
    crashLogger.fatal(safeErrorMetadata(error), message);
  } catch {
    // Last resort: a fixed record, so the exit is still a JSON line and never Node's text stack.
    try {
      const record = {
        level: 60,
        time: new Date().toISOString(),
        appRole: settings.role,
        role: settings.role === AppRole.Worker ? 'worker' : 'api',
        correlationId: null,
        message,
      };
      writeSync(1, `${JSON.stringify(record)}\n`);
    } catch {
      /* nothing left to write to */
    }
  }
  // A handler replaces Node's crash, and a worker interval or an HTTP listener keeps the process
  // alive, so it must end itself.
  process.exit(1);
}

process.on('uncaughtException', error => logFatalAndExit(error, 'Uncaught exception'));
process.on('unhandledRejection', reason => logFatalAndExit(reason, 'Unhandled promise rejection'));
