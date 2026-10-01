import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ErrorCode } from '../errors/error-code.enum';
import type { RequestWithCorrelationId } from '../middleware/correlation-id.middleware';
import { isTransientDbError } from '../utils/pg-error.util';

export const PROBLEM_JSON = 'application/problem+json';

/** Seconds a client should wait before retrying a 503. */
export const RETRY_AFTER_SECONDS = 5;

/** RFC 7807 body, plus the fields our clients rely on. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  /** Stable machine-readable code (see ErrorCode). Only present when the thrower set one. */
  errorCode?: string;
  correlationId?: string;
  /** Per-field messages for a failed validation. */
  errors?: string[];
  [extra: string]: unknown;
}

/**
 * Keys the filter derives itself and therefore never copies from the thrown body. Every other
 * key a thrower attached (`errorCode`, `transferId`, `status`, …) is passed through, so what a
 * service chooses to publish actually reaches the client. A filter that narrows every body to a
 * fixed set of keys silently deletes these.
 *
 * The RFC 7807 members (`type`, `title`, `status`, `detail`) and `correlationId` always win over a
 * passed-through key of the same name. In particular `status` is the HTTP status number: a domain
 * value such as `status: 'REJECTED'` is not forwarded under that name — the reject reason travels
 * as `errorCode` and the transfer id as `transferId`.
 */
const RESHAPED_KEYS = new Set(['statusCode', 'message', 'error', 'errors']);

function titleFor(status: number): string {
  const name = HttpStatus[status] as string | undefined;
  if (!name) return 'Error';
  return name
    .split('_')
    .map(word => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Turns every thrown error into an RFC 7807 `application/problem+json` response.
 *
 *  - HttpException           → its own status; extra body keys (errorCode, …) pass through.
 *  - transient database error → 503 + `Retry-After`; the request made no change, so the client
 *                               may retry with the same Idempotency-Key.
 *  - anything else            → 500 with a generic detail; the real error goes to the log only,
 *                               never to the client.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<RequestWithCorrelationId>();
    const correlationId = request.correlationId;

    const { problem, retryAfterSeconds } = this.toProblem(exception, request, correlationId);
    if (retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
    }
    response.status(problem.status).type(PROBLEM_JSON).json(problem);
  }

  private toProblem(
    exception: unknown,
    request: RequestWithCorrelationId,
    correlationId: string | undefined,
  ): { problem: ProblemDetails; retryAfterSeconds?: number } {
    if (exception instanceof HttpException) {
      return { problem: this.fromHttpException(exception, correlationId) };
    }

    if (isTransientDbError(exception)) {
      this.logger.warn(
        `Transient database error on ${request.method} ${request.url} [${correlationId ?? '-'}]: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
      return {
        problem: {
          type: 'about:blank',
          title: titleFor(HttpStatus.SERVICE_UNAVAILABLE),
          status: HttpStatus.SERVICE_UNAVAILABLE,
          detail: 'Service temporarily unavailable — please retry.',
          errorCode: ErrorCode.SERVICE_TEMPORARILY_UNAVAILABLE,
          correlationId,
        },
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      };
    }

    this.logger.error(
      `Unhandled exception on ${request.method} ${request.url} [${correlationId ?? '-'}]`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    return {
      problem: {
        type: 'about:blank',
        title: titleFor(HttpStatus.INTERNAL_SERVER_ERROR),
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        detail: 'Internal server error',
        correlationId,
      },
    };
  }

  private fromHttpException(
    exception: HttpException,
    correlationId: string | undefined,
  ): ProblemDetails {
    const status = exception.getStatus();
    const raw = exception.getResponse();

    let detail = exception.message;
    let errors: string[] | undefined;
    let passthrough: Record<string, unknown> = {};

    if (typeof raw === 'string') {
      detail = raw;
    } else if (typeof raw === 'object' && raw !== null) {
      const payload = raw as Record<string, unknown>;
      if (Array.isArray(payload.errors)) {
        // UnprocessableEntityException({ errors: [...] }) carries its messages at the root.
        errors = payload.errors.map(item =>
          typeof item === 'object' && item !== null && 'message' in item
            ? String((item as { message: unknown }).message)
            : String(item),
        );
        detail = 'Request validation failed';
      } else if (Array.isArray(payload.message)) {
        // ValidationPipe puts one message per failed constraint here.
        errors = payload.message.map(String);
        detail = 'Request validation failed';
      } else if (typeof payload.message === 'string') {
        detail = payload.message;
      }
      passthrough = Object.fromEntries(
        Object.entries(payload).filter(([key]) => !RESHAPED_KEYS.has(key)),
      );
    }

    return {
      ...passthrough,
      type: 'about:blank',
      title: titleFor(status),
      status,
      detail,
      ...(errors ? { errors } : {}),
      correlationId,
    };
  }
}
