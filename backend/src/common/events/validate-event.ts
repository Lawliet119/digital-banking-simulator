import { accountStatusChangedSchema, transferCompletedSchema } from './event-schemas';
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
  TransferCompleted: transferCompletedSchema,
  AccountStatusChanged: accountStatusChangedSchema,
};

/**
 * `joi` error type to our code, by EXACT name (`string.pattern.base` is a format problem even
 * though it ends in `.base`). Anything not listed becomes INVALID_FORMAT: never ignored, and the
 * function never throws on a type it has not met.
 */
const CODE_OF_JOI_TYPE: Readonly<Record<string, EventIssueCode>> = {
  'any.required': 'MISSING_FIELD',
  'string.base': 'WRONG_TYPE',
  'boolean.base': 'WRONG_TYPE',
  'string.empty': 'INVALID_FORMAT',
  'string.pattern.base': 'INVALID_FORMAT',
  'any.custom': 'INVALID_FORMAT',
  'any.only': 'NOT_ALLOWED',
  'any.unknown': 'NOT_ALLOWED',
};

const codeOf = (joiType: string): EventIssueCode => CODE_OF_JOI_TYPE[joiType] ?? 'INVALID_FORMAT';

/**
 * `joi` can report two problems for one field (`type: 5` is both "not in the list" and "not a
 * string"). The list is meant to say ONE thing per field, and the most basic one wins: a missing
 * field, then a wrong type, then a bad format, then a value that is not allowed.
 */
const PRIORITY: readonly EventIssueCode[] = [
  'MISSING_FIELD',
  'WRONG_TYPE',
  'INVALID_FORMAT',
  'NOT_ALLOWED',
];

function onePerPath(issues: EventIssue[]): EventIssue[] {
  const best = new Map<string, EventIssue>();
  for (const found of issues) {
    const kept = best.get(found.path);
    if (kept === undefined || PRIORITY.indexOf(found.code) < PRIORITY.indexOf(kept.code)) {
      best.set(found.path, found);
    }
  }
  return [...best.values()];
}

/**
 * The DEPOSIT rule (BL-002), which no single field can express: the source of a deposit is the
 * SYSTEM funding account, which has no owner. So `type = DEPOSIT` needs `fromUserId` null and
 * `sameOwner` false; any other type needs a real `fromUserId`.
 *
 * It runs only when `type` itself passed (without a valid type there is no telling which rule
 * applies, and a bad `type` must give one issue, not two), and only for a field that passed its
 * own check (a `fromUserId: 5` is already a WRONG_TYPE; the rule adds nothing to it).
 */
function crossFieldIssues(payload: Record<string, unknown>, failed: Set<string>): EventIssue[] {
  if (failed.has('type')) return [];
  const found: EventIssue[] = [];
  if (payload.type === 'DEPOSIT') {
    if (!failed.has('fromUserId') && payload.fromUserId !== null) {
      found.push(issue('fromUserId', 'NOT_ALLOWED'));
    }
    if (!failed.has('sameOwner') && payload.sameOwner !== false) {
      found.push(issue('sameOwner', 'NOT_ALLOWED'));
    }
  } else if (!failed.has('fromUserId') && payload.fromUserId === null) {
    found.push(issue('fromUserId', 'WRONG_TYPE'));
  }
  return found;
}

/**
 * Checks a message that arrived as `unknown` (parsed JSON) and says what is wrong with it, all at
 * once. On success `event` is the very object that was passed in (not a copy, not modified).
 *
 * Order: (1) a plain object, else NOT_AN_OBJECT; (2) `eventType` picks the schema; (3) each field
 * with `joi`, no type coercion, unknown fields allowed; (4) the DEPOSIT rule, for a TransferCompleted
 * whose type is valid; (5) one issue per path.
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
  const found = (error?.details ?? []).map(detail =>
    issue(detail.path.join('.'), codeOf(detail.type)),
  );
  if (eventType === EVENT_TYPES.TransferCompleted) {
    found.push(...crossFieldIssues(payload, new Set(found.map(f => f.path))));
  }
  if (found.length > 0) return { ok: false, issues: onePerPath(found) };

  return { ok: true, event: payload as unknown as DomainEvent };
}

/**
 * Thrown by `assertEvent`. Carries the same `issues` as `validateEvent`; the message lists field
 * names and codes only, never a value (it reaches logs and, for a consumer, the DLQ).
 */
export class InvalidEventError extends Error {
  constructor(readonly issues: readonly EventIssue[]) {
    super(`Invalid event: ${issues.map(i => `${i.path || '(payload)'} ${i.code}`).join(', ')}`);
    this.name = 'InvalidEventError';
  }
}

/**
 * `validateEvent` that throws, for a PRODUCER about to write an event to the outbox: a bad event
 * there is a programming error, not a message to route. It runs inside the business transaction,
 * so a schema bug makes the transaction fail (closed, on purpose): see BL-011 for what the writer
 * must say about that. A consumer should use `validateEvent` and decide itself (DLQ at once).
 */
export function assertEvent(payload: unknown): DomainEvent {
  const result = validateEvent(payload);
  if (!result.ok) throw new InvalidEventError(result.issues);
  return result.event;
}
