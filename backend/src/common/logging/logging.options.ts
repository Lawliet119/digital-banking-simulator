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
// Keys are normalised first (lower case, no "_" or "-"). Long, specific words match as a
// substring. Short words that also sit inside harmless keys ("footprint" holds "otp", "span"
// holds "pan") match the whole key, or only as a suffix, so "toAccountNo" and "newPin" are
// caught while "cardNotPresent" and "accountNotFound" are not.
const PRIVATE_KEY =
  /authorization|password|passwd|secret|token|cookie|accountnumber|iban|cardnumber|cvv|credential|apikey|privatekey|pwd|jwt|passphrase|connectionstring|databaseurl|securitycode/;
const PRIVATE_EXACT_KEYS = new Set([
  'pan',
  'cardpan',
  'pannumber',
  'otpcode',
  'otpvalue',
  'totp',
  'totpcode',
  'mfacode',
  'smscode',
  'verificationcode',
  'pincode',
  'cardpin',
  'cvc2',
  'sid',
  'sessionid',
  'pass',
  'dsn',
  'signature',
  'auth',
]);
const PRIVATE_KEY_SUFFIXES = ['accountno', 'accountnum', 'cardno', 'cardnum', 'pin', 'otp', 'cvc'];
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
  'headers',
  'rawheaders',
]);
/** A longer string is replaced, not scanned: the scan must stay linear and cheap per log call. */
const MAX_SCANNED_LENGTH = 4096;

function isPrivateKey(normalized: string): boolean {
  return (
    PRIVATE_KEY.test(normalized) ||
    PRIVATE_EXACT_KEYS.has(normalized) ||
    PRIVATE_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix))
  );
}
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

const OMITTED = '[Omitted]';
const FALLBACK_MESSAGE = 'Log call failed';
/** Keys the logger owns. A caller never sets them: they come from the logger itself. */
const ENVELOPE_KEYS = new Set([
  'level',
  'time',
  'message',
  'msg',
  'appRole',
  'role',
  'correlationId',
]);

/** Reads something a hostile value can make throw (getter, Proxy trap); a failure is not fatal. */
function guarded<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Copies a value into a plain, safe structure. A nested value that cannot be read becomes
 * `[Omitted]` on its own, so one bad entry never costs the healthy fields next to it. Only a true
 * cycle (an object inside itself) is cut, a shared object that is not a cycle is kept.
 */
function sanitize(value: unknown, path = new Set<object>(), depth = 0): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return safeErrorMetadata(value);
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return undefined;
  if (isErrorRecord(value)) return safeErrorMetadata(value);
  if (path.has(value) || depth > 12) return OMITTED;
  path.add(value);
  try {
    const child = (read: () => unknown) =>
      guarded(() => sanitize(read(), path, depth + 1), OMITTED);
    if (Array.isArray(value)) {
      const items = value as unknown[];
      return Array.from({ length: items.length }, (_, index) => child(() => items[index]));
    }
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).map(key => {
        const normalized = key.toLowerCase().replace(/[_-]/g, '');
        if (isPrivateKey(normalized) || OMITTED_KEYS.has(normalized)) return [key, REDACTED];
        const item = guarded(() => record[key], OMITTED);
        if (key === 'req') return [key, guarded(() => requestFields(item), {})];
        if (key === 'res') return [key, guarded(() => responseFields(item), {})];
        if (key === 'err' || key === 'error') return [key, safeErrorMetadata(item)];
        if ((key === 'message' || key === 'msg') && typeof item === 'string')
          return [key, safeMessage(item)];
        return [key, child(() => item)];
      }),
    );
  } finally {
    path.delete(value);
  }
}

/** New object with the caller's fields minus the envelope keys; the caller's object is untouched. */
function callerFields(value: object): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter(key => !ENVELOPE_KEYS.has(key))
      .map(key => [key, guarded(() => record[key], OMITTED)]),
  );
}

function placeholderCount(template: string): number {
  return (template.replace(/%%/g, '').match(/%[sdifjoOc]/g) ?? []).length;
}

/** Renders a format string, dropping arguments that fill no placeholder instead of appending them. */
function render(template: string, extras: unknown[]): string {
  const used = extras
    .slice(0, placeholderCount(template))
    .map(arg => guarded(() => sanitize(arg), OMITTED));
  return safeMessage(format(template, ...used));
}

/** The one place a log call's arguments are rebuilt: always `[message]` or `[fields, message]`. */
function prepareArgs(args: unknown[]): [string] | [object, string] {
  const [first, second] = args;
  if (typeof first === 'string') return [render(first, args.slice(1))];
  if (typeof first === 'number' || typeof first === 'boolean' || typeof first === 'bigint')
    return [safeMessage(String(first))];
  if (first === null || typeof first !== 'object') return ['Diagnostic event'];
  const fields =
    first instanceof Error || isErrorRecord(first)
      ? { err: safeErrorMetadata(first) }
      : callerFields(first);
  return [fields, typeof second === 'string' ? render(second, args.slice(2)) : 'Diagnostic event'];
}

/**
 * Defence in depth for any string: credentials in URIs, Bearer and Basic headers, password=… and
 * "password":"…" pairs, and raw JWTs. Callers must still keep secrets out of logs. Every pattern
 * is anchored or bounded so the scan stays linear; a string over MAX_SCANNED_LENGTH is not scanned.
 */
function scrubSecrets(text: string): string {
  if (text.length > MAX_SCANNED_LENGTH) return '[Omitted]';
  return text
    .replace(/\b(?:https?|postgres(?:ql)?|rediss?):\/\/[^\s]+/gi, '[Redacted URI]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [Redacted]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic [Redacted]')
    .replace(
      /\b(password|passwd|token|secret|authorization)"?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[Redacted]',
    )
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, '[Redacted JWT]');
}

/** Defence in depth for diagnostic text; callers must still use fixed, non-sensitive messages. */
function safeMessage(message: string): string {
  return scrubSecrets(message).replace(/\b\d{8,}\b/g, '[Redacted number]');
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
    // Pino runs a `bindings` formatter only on `base` and resets it for every child logger, so
    // bindings added by `child()`, `assign()` or `runInContext` are not filtered here. That is the
    // boundary with DBS-43: it must bind each context once and keep sensitive data out of it.
    formatters: {
      log: object =>
        guarded(() => sanitize(object) as Record<string, unknown>, {
          role: guarded(() => object.role, 'api'),
          correlationId: guarded(() => object.correlationId, null),
        }),
    },
    hooks: {
      // Rebuild the arguments before Pino merges the envelope; a failure must never reach the
      // caller (a log call sits on error and retry paths), so fall back to a fixed line, and if
      // even that cannot be written, drop the line.
      logMethod(args, method) {
        try {
          method.apply(this, prepareArgs(args));
        } catch {
          try {
            method.call(this, FALLBACK_MESSAGE);
          } catch {
            /* the line is lost, the caller is not */
          }
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
