export interface TransferStamp {
  readonly transferId: string;
  /** ISO-8601 instant of the transfer (the event's `occurredAt`). */
  readonly occurredAt: string;
}

/**
 * Reference semantics of `Features.txCount10m` (and the other transfer-count windows): how many
 * distinct transfers left one source account in `(current.occurredAt - windowMinutes,
 * current.occurredAt]`, the current transfer included once (FRAUD_DETECTION_GUIDE §4.2: window
 * ends at `occurredAt`, never at the worker clock).
 *
 * Pure: it reads no store. A provider (Redis sorted set, SQL view, or in-memory history for the
 * offline run) must give the same answer; its own tests (DBS-109/128/112) prove that against
 * the real source. The lower bound is exclusive: a transfer exactly `windowMinutes` earlier is out.
 * Distinct by `transferId`, so a redelivered event is not counted twice; transfers after
 * `occurredAt` (a late delivery of an earlier event) are not counted.
 */
export function countTransfersInWindow(
  current: TransferStamp,
  history: readonly TransferStamp[],
  windowMinutes: number,
): number {
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1) {
    throw new Error('windowMinutes must be a positive integer');
  }
  const until = instant(current.occurredAt);
  const from = until - windowMinutes * 60_000;
  const ids = new Set<string>([current.transferId]);
  for (const past of history) {
    const at = instant(past.occurredAt);
    if (at > from && at <= until) ids.add(past.transferId);
  }
  return ids.size;
}

function instant(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error('Invalid transfer timestamp');
  return ms;
}
