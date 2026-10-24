import type { RequestHandler } from 'express';
import { PinoLogger } from 'nestjs-pino';
import pinoHttp from 'pino-http';
import type { RequestWithCorrelationId } from '../middleware/correlation-id.middleware';
import { createLoggingOptions, type LoggingSettings } from './logging.options';

/** Mounted before CORS/body parsing so even rejected and short-circuited requests are traced. */
export function createHttpLogging(logger: PinoLogger, settings: LoggingSettings): RequestHandler {
  const middleware = pinoHttp({ ...createLoggingOptions(settings), logger: logger.logger });
  return (req: RequestWithCorrelationId, res, next) => {
    logger.runInContext(() => middleware(req, res, next), {
      bindings: { role: 'api', correlationId: req.correlationId ?? null },
    });
  };
}
