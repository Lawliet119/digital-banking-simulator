import type { TransferCompleted } from '@common/events';

/** Point-in-time facts for R1–R6; money stays exact, in whole-dong decimal strings. */
export interface Features {
  /** Includes the current transfer, with windows ending at event.occurredAt. */
  readonly txCount10m: number;
  readonly txCount1h: number;
  /** Completed transfers strictly before event.occurredAt. */
  readonly historyCount30d: number;
  /** Twice the exact median amount; null when historyCount30d is below five. */
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
