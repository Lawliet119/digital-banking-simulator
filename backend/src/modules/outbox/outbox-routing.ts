import type { EventType } from '@common/events';

/** One queue per consumer (docs/03 §10): a message in a shared queue reaches only one of them. */
export type OutboxQueue = 'risk' | 'notification';

/**
 * Routing table of the relay: every queue that cares about an event gets its own copy. v1 does not
 * publish `TransferRejected` (nobody consumes it), see docs/03 §10.
 */
export const OUTBOX_ROUTES: Readonly<Record<EventType, readonly OutboxQueue[]>> = {
  TransferCompleted: ['risk', 'notification'],
  AccountStatusChanged: ['notification'],
};

export const ROUTED_EVENT_TYPES: readonly string[] = Object.keys(OUTBOX_ROUTES);
