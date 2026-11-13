import type { TransferCompleted } from '@common/events';

/**
 * The history window of R2, in days, and the fewest rows from which a median is produced. They are
 * the `historyDays` and `minHistory` of the seeded rule set v1 and R2 refuses any other
 * `historyDays` and any `minHistory` below `MIN_HISTORY_FOR_MEDIAN`; `history-window.spec.ts` keeps
 * the three in step. Both providers (SQL and offline) take them from here.
 */
export const HISTORY_DAYS = 30;
export const MIN_HISTORY_FOR_MEDIAN = 5;

/** Point-in-time facts for R1–R6; money stays exact, in whole-dong decimal strings. */
export interface Features {
  /** Includes the current transfer, with windows ending at event.occurredAt. */
  readonly txCount10m: number;
  readonly txCount1h: number;
  /**
   * Completed transfers of the source account in the `HISTORY_DAYS` (30) days strictly before
   * event.occurredAt. `medianAmount30dTimes2` is computed over exactly these rows, never a different
   * set (one query, one window), so the count that gates R2 (`minHistory`) and the median it then
   * reads describe the same history.
   */
  readonly historyCount30d: number;
  /**
   * Twice the exact median amount of the same rows as `historyCount30d`; null when that count is
   * below `MIN_HISTORY_FOR_MEDIAN` (five).
   */
  readonly medianAmount30dTimes2: string | null;
  /** ISO UTC timestamp of the latest reverse transfer in the prior hour. */
  readonly reverseTransferOccurredAt: string | null;
  /** Counts include the current transfer. */
  readonly newRecipients1h: number;
  readonly distinctRecipients24h: number;
  readonly sumOut24h: string;
  readonly smallTxCount24h: number;
}

export type TransferEvent = TransferCompleted & { type: 'TRANSFER' };

/** Both live and offline sources must produce the same point-in-time feature shape. */
export interface FeatureProvider {
  extract(event: TransferEvent): Promise<Features>;
}
