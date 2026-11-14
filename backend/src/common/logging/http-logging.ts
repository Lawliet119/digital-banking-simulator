import type { RequestHandler } from 'express';
import { PinoLogger } from 'nestjs-pino';
import pinoHttp from 'pino-http';
import type { RequestWithCorrelationId } from '../middleware/correlation-id.middleware';
import { runInLogContext } from './log-context';
import { createLoggingOptions, requestId, type LoggingSettings } from './logging.options';

/** Mounted before CORS/body parsing so even rejected and short-circuited requests are traced. */
export function createHttpLogging(logger: PinoLogger, settings: LoggingSettings): RequestHandler {
  const middleware = pinoHttp({ ...createLoggingOptions(settings), logger: logger.logger });
  return (req: RequestWithCorrelationId, res, next) => {
    // Resolve the id first so the handler's logs, the completion line and the response header all
    // carry the same one, even when this logger is mounted without the correlation middleware.
    const id = requestId(req, res);
    runInLogContext(() => middleware(req, res, next), { role: 'api', correlationId: id });
  };
}
