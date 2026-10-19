import * as Joi from 'joi';
import { accountStatusChangedFields, transferCompletedFields } from './event-schemas';
import { EVENT_TYPES, type DomainEvent } from './event-types';

/**
 * Why an event was refused, as a code a consumer can branch on. Tests and callers use `code` and
 * `path`; the `message` is only a human hint.
 */
export type EventIssueCode =
  | 'NOT_AN_OBJECT'
  | 'UNKNOWN_EVENT_TYPE'
  | 'MISSING_FIELD'
  | 'WRONG_TYPE'
  | 'INVALID_FORMAT'
  | 'NOT_ALLOWED';

export interface EventIssue {
  /** The field name; `''` for the whole payload. */
  path: string;
  code: EventIssueCode;
  /** A fixed sentence for the code: never the value that was received. */
  message: string;
}

export type EventValidation =
  { ok: true; event: DomainEvent } | { ok: false; issues: EventIssue[] };

const MESSAGES: Record<EventIssueCode, string> = {
  NOT_AN_OBJECT: 'must be a JSON object',
  UNKNOWN_EVENT_TYPE: 'is not a known event type',
  MISSING_FIELD: 'is required',
  WRONG_TYPE: 'has the wrong type',
  INVALID_FORMAT: 'has an invalid format',
  NOT_ALLOWED: 'is not allowed',
};

const issue = (path: string, code: EventIssueCode): EventIssue => ({
  path,
  code,
  message: MESSAGES[code],
});

/**
 * A payload from `JSON.parse`, or a bare object with no prototype. Not `Date`, `Map`, an array or an
 * instance of a class. The test is "its prototype is a root (it has no prototype of its own)" and
 * NOT "its prototype is `Object.prototype`": an object made in another realm (a worker, a `vm`
 * context, Jest's sandbox for `structuredClone`) has a different `Object.prototype` and is still
 * a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Object.prototype.toString.call(value) !== '[object Object]') return false; // Array, Date, Map…
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

const SCHEMAS = {
  TransferCompleted: Joi.object(transferCompletedFields),
  AccountStatusChanged: Joi.object(accountStatusChangedFields),
};

/** `joi` error type to our code. Anything not listed becomes INVALID_FORMAT: never ignored. */
function codeOf(joiType: string): EventIssueCode {
  if (joiType === 'any.required') return 'MISSING_FIELD';
  return 'INVALID_FORMAT';
}

/**
 * Checks a message that arrived as `unknown` (parsed JSON) and says what is wrong with it, all at
 * once. On success `event` is the very object that was passed in (not a copy, not modified).
 *
 * Order: (1) a plain object, else NOT_AN_OBJECT; (2) `eventType` picks the schema; (3) each field
 * with `joi`, no type coercion, unknown fields allowed.
 */
export function validateEvent(payload: unknown): EventValidation {
  if (!isPlainObject(payload)) return { ok: false, issues: [issue('', 'NOT_AN_OBJECT')] };

  const eventType = payload.eventType;
  if (eventType === undefined) return { ok: false, issues: [issue('eventType', 'MISSING_FIELD')] };
  if (typeof eventType !== 'string')
    return { ok: false, issues: [issue('eventType', 'WRONG_TYPE')] };
  if (!Object.prototype.hasOwnProperty.call(EVENT_TYPES, eventType)) {
    return { ok: false, issues: [issue('eventType', 'UNKNOWN_EVENT_TYPE')] };
  }

  const schema = SCHEMAS[eventType as keyof typeof SCHEMAS];
  const { error } = schema.validate(payload, {
    convert: false,
    allowUnknown: true,
    abortEarly: false,
  });
  if (error) {
    const issues = error.details.map(detail => issue(detail.path.join('.'), codeOf(detail.type)));
    return { ok: false, issues };
  }

  return { ok: true, event: payload as unknown as DomainEvent };
}
