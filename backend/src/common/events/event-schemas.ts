import * as Joi from 'joi';
import type { AccountStatusChanged, TransferCompleted } from './event-types';

/**
 * One `joi` schema per field of each event. `satisfies Record<keyof T, Joi.Schema>` is the point:
 * a field added to (or removed from) an event type without touching this file is a compile error,
 * so the type and the schema cannot drift apart unnoticed. It only sees keys shared by every
 * branch of a union, hence the rule in event-types.ts: new TransferCompleted fields go on the
 * common part.
 *
 * Internal to `@common/events`: callers use `validateEvent`, never `joi` directly.
 */

/** A required string. Its format (uuid, money, time) is tightened in the next steps of DBS-24. */
const text = Joi.string().required();

export const transferCompletedFields = {
  eventId: text,
  eventType: Joi.string().valid('TransferCompleted').required(),
  occurredAt: text,
  correlationId: text,
  transferId: text,
  type: Joi.string().valid('TRANSFER', 'DEPOSIT').required(),
  fromAccountId: text,
  toAccountId: text,
  amount: text,
  fromBalanceBefore: text,
  fromAccountCreatedAt: text,
  toAccountCreatedAt: text,
  sameOwner: Joi.boolean().required(),
  // uuid or null; null only means something for a DEPOSIT (a cross-field rule, applied later).
  // Not Joi.alternatives(): its error type, `alternatives.types`, would hide a WRONG_TYPE.
  fromUserId: Joi.string().allow(null).required(),
  toUserId: text,
} satisfies Record<keyof TransferCompleted, Joi.Schema>;

export const accountStatusChangedFields = {
  eventId: text,
  eventType: Joi.string().valid('AccountStatusChanged').required(),
  occurredAt: text,
  correlationId: text,
  accountId: text,
  ownerUserId: text,
  newStatus: Joi.string().valid('ACTIVE', 'LOCKED').required(),
  changedByUserId: text,
} satisfies Record<keyof AccountStatusChanged, Joi.Schema>;
