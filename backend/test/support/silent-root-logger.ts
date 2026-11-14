import { PinoLogger } from 'nestjs-pino';

/**
 * Sets the process-wide pino root that `currentLogger()` and `runInLogContext` read (BL-024),
 * silenced, for a test that builds a consumer or the outbox writer by hand. Consumers and the
 * writer no longer take a `PinoLogger` argument, so this is the only place a test makes one.
 */
export function installSilentRootLogger(): PinoLogger {
  return new PinoLogger({ pinoHttp: { level: 'silent' } } as never);
}
