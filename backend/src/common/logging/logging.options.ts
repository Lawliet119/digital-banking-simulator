import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { format } from 'node:util';
import pino, { type Level } from 'pino';
import type { Options } from 'pino-http';
import type { RequestWithCorrelationId } from '../middleware/correlation-id.middleware';
import { CORRELATION_ID_HEADER } from '../middleware/correlation-id.middleware';
import { logLevels } from '../utils/log-levels';

export interface LoggingSettings {
  role: 'api' | 'worker' | 'both';
  logLevel?: string;
}

const LEVELS: Record<string, Level> = {
  verbose: 'trace',
  debug: 'debug',
  log: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
};
const PRIVATE_KEY =
  /authorization|password|passwd|secret|token|cookie|accountnumber|iban|cardnumber|cvv/;
const OMITTED_KEYS = new Set([
  'body',
  'query',
  'parameters',
  'sql',
  'stack',
  'cause',
  'url',
  'originalurl',
  'raw',
]);
const METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'CONNECT',
  'TRACE',
]);
const REDACTED = '[Redacted]';

const MAX_CAUSE_DEPTH = 4;
/** A SQLSTATE read from the driver is 5 characters and never carries data. */
const DRIVER_SQLSTATE = /^[0-9A-Z]{5}$/;
/** A bare `code` may come from anywhere, so only classes with no user data are kept. */
const BARE_SQLSTATE = /^(?:08|23|25|28|3D|40|42|53|55|57|58)[A-Z0-9]{3}$/;
const NETWORK_CODE = /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)$/;

/** First `code` on the error or what it wraps, in the order pg-error.util walks it. */
function findCode(error: unknown): { code: string; fromDriver: boolean } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === 'object'; depth++) {
    const record = current as { code?: unknown; driverError?: unknown; cause?: unknown };
    const driver = record.driverError;
    if (driver && typeof driver === 'object') {
      const driverCode = (driver as { code?: unknown }).code;
      if (typeof driverCode === 'string') return { code: driverCode, fromDriver: true };
    }
    if (typeof record.code === 'string') return { code: record.code, fromDriver: false };
    current = driver ?? record.cause;
  }
  return undefined;
}

/**
 * Error text can contain SQL values and credentials; only a bounded technical code is safe.
 * Total: a hostile value (revoked Proxy, throwing getter) yields `NonError`, never an exception,
 * because callers use it on error paths where a second failure would hide the first.
 */
export function safeErrorMetadata(error: unknown): { errorType: string; code?: string } {
  try {
    const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
    const found = findCode(error);
    const validCode =
      found !== undefined &&
      ((found.fromDriver && DRIVER_SQLSTATE.test(found.code)) ||
        BARE_SQLSTATE.test(found.code) ||
        NETWORK_CODE.test(found.code));
    return {
      errorType: error instanceof Error || record.errorType === 'Error' ? 'Error' : 'NonError',
      ...(validCode ? { code: found.code } : {}),
    };
  } catch {
    return { errorType: 'NonError' };
  }
}

function requestFields(value: unknown): { method?: string } {
  const method = value && typeof value === 'object' && 'method' in value ? value.method : undefined;
  return typeof method === 'string' && METHODS.has(method) ? { method } : {};
}

function responseFields(value: unknown): { statusCode?: number } {
  const status =
    value && typeof value === 'object' && 'statusCode' in value ? value.statusCode : undefined;
  return typeof status === 'number' && status >= 100 && status <= 599 ? { statusCode: status } : {};
}

function isErrorRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'message' in value &&
    ('stack' in value || 'code' in value || 'cause' in value || 'name' in value)
  );
}

function sanitize(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value instanceof Error) return safeErrorMetadata(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (isErrorRecord(value)) return safeErrorMetadata(value);
  if (seen.has(value) || depth > 12) return '[Omitted]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const normalized = key.toLowerCase().replace(/[_-]/g, '');
      if (PRIVATE_KEY.test(normalized) || OMITTED_KEYS.has(normalized)) return [key, REDACTED];
      if (key === 'req') return [key, requestFields(item)];
      if (key === 'res') return [key, responseFields(item)];
      if (key === 'err' || key === 'error') return [key, safeErrorMetadata(item)];
      if ((key === 'message' || key === 'msg') && typeof item === 'string')
        return [key, safeMessage(item)];
      return [key, sanitize(item, seen, depth + 1)];
    }),
  );
}

/** Defence in depth for diagnostic text; callers must still use fixed, non-sensitive messages. */
function safeMessage(message: string): string {
  return message
    .replace(/\b(?:https?|postgres(?:ql)?|rediss?):\/\/[^\s]+/gi, '[Redacted URI]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [Redacted]')
    .replace(
      /\b(password|passwd|token|secret|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[Redacted]',
    )
    .replace(/\b\d{8,}\b/g, '[Redacted number]');
}

function requestId(req: IncomingMessage, res: ServerResponse): string {
  const request = req as RequestWithCorrelationId;
  // configureHttpApp normally assigned it already; the fallback is also server-generated.
  if (!request.correlationId) {
    request.correlationId = randomUUID();
    res.setHeader(CORRELATION_ID_HEADER, request.correlationId);
  }
  return request.correlationId;
}

export function createLoggingOptions(settings: LoggingSettings): Options {
  const enabled = logLevels(settings.logLevel);
  return {
    level: LEVELS[enabled[enabled.length - 1]],
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { appRole: settings.role },
    mixin(_context, _level, logger) {
      const bindings = logger.bindings();
      return {
        ...(!('role' in bindings) ? { role: settings.role === 'worker' ? 'worker' : 'api' } : {}),
        ...(!('correlationId' in bindings) ? { correlationId: null } : {}),
      };
    },
    formatters: {
      log: object => sanitize(object) as Record<string, unknown>,
      bindings: bindings => sanitize(bindings) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        // Wrap before Pino adds envelope fields; projecting the merged record would erase them.
        if (args[0] instanceof Error || isErrorRecord(args[0])) {
          args[0] = { err: safeErrorMetadata(args[0]) };
        }
        // Pino interpolates after this hook: sanitize arguments first and the rendered text last.
        if (typeof args[0] === 'string') {
          method.call(
            this,
            safeMessage(format(args[0], ...args.slice(1).map(arg => sanitize(arg)))),
          );
        } else {
          const message =
            typeof args[1] === 'string'
              ? safeMessage(format(args[1], ...args.slice(2).map(arg => sanitize(arg))))
              : 'Diagnostic event';
          method.call(this, args[0], message);
        }
      },
    },
    wrapSerializers: false,
    serializers: {
      req: requestFields,
      res: responseFields,
      // formatters.log already removes raw Error data, so do not re-expand it here.
      err: (value: unknown) => value,
    },
    genReqId: requestId,
    customProps: (req, res) => ({ role: 'api', correlationId: requestId(req, res) }),
    customSuccessMessage: () => 'Request completed',
    customErrorMessage: () => 'Request failed',
    customLogLevel: (_req, res, error) =>
      error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  };
}
