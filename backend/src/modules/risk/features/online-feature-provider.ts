import { riskTimeMilliseconds } from '../risk-time';
import {
  MIN_HISTORY_FOR_MEDIAN,
  type FeatureProvider,
  type Features,
  type TransferEvent,
} from './feature-provider';
import { TransferFacts } from './transfer-facts';

export interface OnlineFeatureProviderDeps {
  readonly facts: TransferFacts;
  /** Maximum amount of one transfer; a "small" transfer is under a tenth of it. */
  readonly perTxLimit: bigint;
}

/**
 * SQL-authoritative features, read before the consumer's decision transaction.
 * Delivery order is not commit order: a Redis coverage timestamp cannot prove that
 * every committed transfer has been consumed. Always read the committed facts.
 * Windows use event time at millisecond resolution; R3/R6 retain event snapshots.
 * The five SELECTs share one `REPEATABLE READ READ ONLY` snapshot (`TransferFacts.snapshot`).
 * SQL failures reject extraction so the consumer can retry, never score partial facts.
 */
export class OnlineFeatureProvider implements FeatureProvider {
  private readonly facts: TransferFacts;
  private readonly perTxLimit: bigint;

  constructor(deps: OnlineFeatureProviderDeps) {
    this.facts = deps.facts;
    this.perTxLimit = deps.perTxLimit;
  }

  async extract(event: TransferEvent): Promise<Features> {
    const occMs = riskTimeMilliseconds(event.occurredAt);
    // One snapshot for all five SELECTs (BL-187): they all see the same committed facts. They run
    // one after another on the snapshot's single connection; the driver deprecates queueing
    // several queries on one client, and PostgreSQL would execute them serially anyway.
    const [transfers, recipients, history, reverseTransferOccurredAt, outflow] =
      await this.facts.snapshot(
        async facts =>
          [
            await facts.velocity(event.fromAccountId, event.transferId, occMs),
            await facts.newRecipientCount(event.fromAccountId, occMs),
            await facts.history(event.fromAccountId, occMs),
            await facts.reverseTransfer(event.fromAccountId, event.toAccountId, occMs),
            await facts.outflow24h(event.fromAccountId, occMs, this.perTxLimit),
          ] as const,
      );
    // Preserve the reference R1 contract even when the current row is not visible.
    const current = transfers.includesCurrent ? 0 : 1;
    const txCount10m = transfers.tenMinutes + current;
    const txCount1h = transfers.hour + current;
    return {
      txCount10m,
      txCount1h,
      historyCount30d: history.count,
      medianAmount30dTimes2: history.count >= MIN_HISTORY_FOR_MEDIAN ? history.median2 : null,
      reverseTransferOccurredAt,
      newRecipients1h: recipients,
      distinctRecipients24h: outflow.distinctRecipients,
      sumOut24h: outflow.sum,
      smallTxCount24h: outflow.small,
    };
  }
}
