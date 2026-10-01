import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

/** Express request carrying the id assigned by `correlationIdMiddleware`. */
export type RequestWithCorrelationId = Request & { correlationId?: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Gives every request one correlation id and echoes it in the `X-Correlation-Id` response header.
 *
 * An id sent by the caller is reused only when it is a well-formed UUID; anything else is
 * replaced, so a client can never inject arbitrary text (log forging) into our logs and audit
 * records. The same id later travels API → outbox → queue → consumer → audit (NFR-OBS-01).
 */
export function correlationIdMiddleware(
  req: RequestWithCorrelationId,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header(CORRELATION_ID_HEADER);
  const id = incoming && UUID_PATTERN.test(incoming) ? incoming.toLowerCase() : randomUUID();
  req.correlationId = id;
  res.setHeader(CORRELATION_ID_HEADER, id);
  next();
}
