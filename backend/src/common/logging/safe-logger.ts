import type { LoggerService } from '@nestjs/common';

type Level = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

const FALLBACK_MESSAGE = 'Log call failed';

/**
 * Nest's static `Logger` (used by the exception filter and TransactionService) delegates to the
 * logger given to NestFactory. A log call sits on error and retry paths: if it throws, for
 * instance on a hostile object, `onRetry` skips the retry and a 503 becomes a 500. This wrapper
 * makes every call total: on failure it writes a fixed line at the same level straight to the
 * inner logger (not through Nest's Logger, so it cannot loop) and swallows any second failure.
 *
 * It does not cover code that calls `PinoLogger` or `req.log` directly; those only get the
 * protection inside the pino hook (see logging.options.ts).
 */
export class SafeLogger implements LoggerService {
  constructor(private readonly inner: LoggerService) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.call('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.call('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.call('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.call('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.call('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.call('fatal', message, optionalParams);
  }

  private call(level: Level, message: unknown, optionalParams: unknown[]): void {
    try {
      this.inner[level]?.(message, ...optionalParams);
    } catch {
      try {
        this.inner[level]?.(FALLBACK_MESSAGE);
      } catch {
        /* the line is lost, the caller is not */
      }
    }
  }
}
