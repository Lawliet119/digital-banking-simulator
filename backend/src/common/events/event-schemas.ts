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

/** Presence only for now; the kind of each field is tightened in the next steps of DBS-24. */
const present = Joi.any().required();

export const transferCompletedFields = {
  eventId: present,
  eventType: present,
  occurredAt: present,
  correlationId: present,
  transferId: present,
  type: present,
  fromAccountId: present,
  toAccountId: present,
  amount: present,
  fromBalanceBefore: present,
  fromAccountCreatedAt: present,
  toAccountCreatedAt: present,
  sameOwner: present,
  fromUserId: present,
  toUserId: present,
} satisfies Record<keyof TransferCompleted, Joi.Schema>;

export const accountStatusChangedFields = {
  eventId: present,
  eventType: present,
  occurredAt: present,
  correlationId: present,
  accountId: present,
  ownerUserId: present,
  newStatus: present,
  changedByUserId: present,
} satisfies Record<keyof AccountStatusChanged, Joi.Schema>;
