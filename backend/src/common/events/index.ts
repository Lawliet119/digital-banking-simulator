// Public surface of @common/events. Import from here (`import { validateEvent } from
// '@common/events'`), never from a file inside the folder.
//
// Not exported on purpose: the `joi` schemas (`event-schemas.ts`). Callers use `validateEvent`;
// that keeps `joi` an implementation detail that can be swapped without touching a consumer.
// `TransferCompletedCommon` is internal too: use `TransferCompleted`.
export {
  EVENT_TYPES,
  type AccountStatusChanged,
  type DomainEvent,
  type EventType,
  type TransferCompleted,
} from './event-types';
export {
  assertEvent,
  InvalidEventError,
  validateEvent,
  type EventIssue,
  type EventIssueCode,
  type EventValidation,
} from './validate-event';
