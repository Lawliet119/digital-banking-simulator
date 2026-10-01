import type { LogLevel } from '@nestjs/common';

/** Ordered from most to least severe. */
const ORDER: readonly LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

/** Nest log levels enabled when `LOG_LEVEL` is `level`: that level and everything more severe. */
export function logLevels(level: string | undefined): LogLevel[] {
  const index = ORDER.indexOf((level ?? 'log') as LogLevel);
  return ORDER.slice(0, (index === -1 ? ORDER.indexOf('log') : index) + 1);
}
