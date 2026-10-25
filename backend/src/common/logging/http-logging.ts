import type { RequestHandler } from 'express';
import { PinoLogger } from 'nestjs-pino';
import pinoHttp from 'pino-http';
import type { RequestWithCorrelationId } from '../middleware/correlation-id.middleware';
import { createLoggingOptions, requestId, type LoggingSettings } from './logging.options';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mounted before CORS/body parsing so even rejected and short-circuited requests are traced. */
export function createHttpLogging(logger: PinoLogger, settings: LoggingSettings): RequestHandler {
  const middleware = pinoHttp({ ...createLoggingOptions(settings), logger: logger.logger });
  return (req: RequestWithCorrelationId, res, next) => {
    // Resolve the id first so the handler's logs, the completion line and the response header all
    // carry the same one, even when this logger is mounted without the correlation middleware.
    const id = requestId(req, res);
    logger.runInContext(() => middleware(req, res, next), {
      bindings: { role: 'api', correlationId: UUID.test(id) ? id : null },
    });
  };
}
