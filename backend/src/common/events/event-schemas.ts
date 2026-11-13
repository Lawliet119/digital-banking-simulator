import * as Joi from 'joi';
import { parseBalance, parsePositiveMoney } from '@common/money';
import type { AccountStatusChanged, TransferCompleted } from './event-types';
import { isRealUtcTime } from './utc-time';

/**
 * One `joi` schema per field of each event. `satisfies Record<keyof T, Joi.Schema>` is the point:
 * a field added to (or removed from) an event type without touching this file is a compile error,
 * so the type and the schema cannot drift apart unnoticed. It only sees keys shared by every
 * branch of a union, hence the rule in event-types.ts: new TransferCompleted fields go on the
 * common part.
 *
 * Internal to `@common/events`: callers use `validateEvent`, never `joi` directly.
 */

/**
 * A canonical lower-case uuid, spelled out instead of `Joi.string().uuid()` (which also accepts
 * braces and no hyphens). Lower case only: ids are compared as plain strings in Redis keys such as
 * `risk:vel:{accountId}`, and Postgres and `randomUUID()` both emit lower case, so an upper-case id
 * would split a fraud counter in two. The regex is linear, so a 1 MB string is refused at once.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = Joi.string().pattern(UUID).required();

/** A timestamp field: ISO-8601 UTC with `Z` and a real calendar date (`isRealUtcTime`). */
const time = Joi.string()
  .custom((value: string) => {
    if (!isRealUtcTime(value)) throw new Error('not a real UTC time');
    return value;
  })
  .required();

/** Whole dong above zero, within 2^63 - 1: the same parser the service uses (`@common/money`). */
const positiveMoney = Joi.string()
  .custom((value: string) => {
    parsePositiveMoney(value);
    return value;
  })
  .required();

/** A signed balance; negative for the SYSTEM `funding` account (ADR-09). */
const signedBalance = Joi.string()
  .custom((value: string) => {
    parseBalance(value);
    return value;
  })
  .required();

export const transferCompletedFields = {
  eventId: uuid,
  eventType: Joi.string().valid('TransferCompleted').required(),
  occurredAt: time,
  correlationId: uuid,
  transferId: uuid,
  type: Joi.string().valid('TRANSFER', 'DEPOSIT').required(),
  fromAccountId: uuid,
  toAccountId: uuid,
  amount: positiveMoney,
  fromBalanceBefore: signedBalance,
  fromAccountCreatedAt: time,
  toAccountCreatedAt: time,
  sameOwner: Joi.boolean().required(),
  // uuid or null; null only means something for a DEPOSIT (a cross-field rule, applied later).
  // Not Joi.alternatives(): its error type, `alternatives.types`, would hide a WRONG_TYPE.
  fromUserId: Joi.string().pattern(UUID).allow(null).required(),
  toUserId: uuid,
} satisfies Record<keyof TransferCompleted, Joi.Schema>;

export const accountStatusChangedFields = {
  eventId: uuid,
  eventType: Joi.string().valid('AccountStatusChanged').required(),
  occurredAt: time,
  correlationId: uuid,
  accountId: uuid,
  ownerUserId: uuid,
  newStatus: Joi.string().valid('ACTIVE', 'LOCKED').required(),
  changedByUserId: uuid,
} satisfies Record<keyof AccountStatusChanged, Joi.Schema>;

export const transferCompletedSchema = Joi.object(transferCompletedFields);

/**
 * `reason` is forbidden: the event carries no lock reason (it lives in `audit_log`) and a customer
 * notification never states a fraud reason (BR-13). This is a tripwire on one name, not the BR-13
 * control (a field called `lockReason` still passes as an unknown field): the real control is that
 * the notification template never prints a reason. It sits outside `accountStatusChangedFields`
 * because `reason` is not a field of the type.
 */
export const accountStatusChangedSchema = Joi.object({
  ...accountStatusChangedFields,
  reason: Joi.any().forbidden(),
});
