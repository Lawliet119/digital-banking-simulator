import { riskTimeNanoseconds } from '../risk-time';
import { RiskMetrics, type FallbackRule } from '../risk.metrics';
import type { FeatureProvider, Features, TransferEvent } from './feature-provider';
import { TransferFacts } from './transfer-facts';
import { WindowCounter, type CounterRedis } from './window-counter';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** R2 needs at least this many past transfers before a median means anything. */
const MIN_HISTORY_FOR_MEDIAN = 5;

export interface OnlineFeatureProviderDeps {
  readonly facts: TransferFacts;
  readonly redis: CounterRedis;
  /** Maximum amount of one transfer; a "small" transfer is under a tenth of it. */
  readonly perTxLimit: bigint;
  readonly metrics: RiskMetrics;
}

/**
 * Live features for R1 to R6 (DBS-109). R1 and R5 read Redis sorted sets that are only a cache of
 * SQL: a set answers when it proves it covers the window, otherwise (cold, outdated generation,
 * late event, Redis error or an open breaker) the same numbers come from `v_transfer_facts` and the
 * set is loaded again. R2 and R4 and the 24h figures always come from SQL. R3 and R6 need nothing:
 * they read the snapshot in the event.
 *
 * Call it **before** the consumer opens its transaction: Redis and these reads never run inside it.
 * Windows follow the event's `occurredAt`, never the worker clock, at millisecond resolution.
 */
export class OnlineFeatureProvider implements FeatureProvider {
  private readonly facts: TransferFacts;
  private readonly velocity: WindowCounter;
  private readonly fanOut: WindowCounter;
  private readonly perTxLimit: bigint;
  private readonly metrics: RiskMetrics;
  /**
   * Set when a Redis call failed: this process may have skipped writing an entry, so before it
   * trusts any set again it raises the shared generation, which retires every coverage mark.
   */
  private generationStale = false;

  constructor(deps: OnlineFeatureProviderDeps) {
    this.facts = deps.facts;
    this.velocity = new WindowCounter(deps.redis, 'risk:vel');
    this.fanOut = new WindowCounter(deps.redis, 'risk:fan');
    this.perTxLimit = deps.perTxLimit;
    this.metrics = deps.metrics;
  }

  async extract(event: TransferEvent): Promise<Features> {
    const occMs = Number(riskTimeNanoseconds(event.occurredAt) / 1_000_000n);
    const [velocity, newRecipients1h, history, reverseTransferOccurredAt, outflow] =
      await Promise.all([
        this.countTransfers(event, occMs),
        this.countNewRecipients(event, occMs),
        this.facts.history(event.fromAccountId, occMs),
        this.facts.reverseTransfer(event.fromAccountId, event.toAccountId, occMs),
        this.facts.outflow24h(event.fromAccountId, occMs, this.perTxLimit),
      ]);
    return {
      txCount10m: velocity.tenMinutes,
      txCount1h: velocity.hour,
      historyCount30d: history.count,
      medianAmount30dTimes2: history.count >= MIN_HISTORY_FOR_MEDIAN ? history.median2 : null,
      reverseTransferOccurredAt,
      newRecipients1h,
      distinctRecipients24h: outflow.distinctRecipients,
      sumOut24h: outflow.sum,
      smallTxCount24h: outflow.small,
    };
  }

  /** Runs a Redis step; on any failure counts the fallback and answers `undefined`. */
  private async attempt<T>(rule: FallbackRule, step: () => Promise<T>): Promise<T | undefined> {
    try {
      return await step();
    } catch {
      this.metrics.redisFallback(rule, 'error');
      this.generationStale = true;
      return undefined;
    }
  }

  private bumping: Promise<void> | undefined;

  /** One bump per outage, even when R1 and R5 notice it at the same moment. */
  private async trusted(counter: WindowCounter): Promise<void> {
    if (!this.generationStale) return;
    this.bumping ??= counter
      .bumpGeneration()
      .then(() => {
        this.generationStale = false;
      })
      .finally(() => {
        this.bumping = undefined;
      });
    await this.bumping;
  }

  /** R1: transfers from the source account in `(occ - 10m, occ]` and `(occ - 1h, occ]`, this one included. */
  private async countTransfers(
    event: TransferEvent,
    occMs: number,
  ): Promise<{ tenMinutes: number; hour: number }> {
    const account = event.fromAccountId;
    const hourFrom = occMs - HOUR + 1;
    const tenFrom = occMs - 10 * MIN + 1;
    const state = await this.attempt('R1', async () => {
      await this.trusted(this.velocity);
      return this.velocity.lookup(account, hourFrom);
    });
    if (state?.covered) {
      const counts = await this.attempt('R1', async () => {
        await this.velocity.add(account, event.transferId, occMs);
        return {
          tenMinutes: await this.velocity.count(account, tenFrom, occMs),
          hour: await this.velocity.count(account, hourFrom, occMs),
        };
      });
      if (counts) return counts;
    } else if (state) {
      this.metrics.redisFallback('R1', 'cold');
    }

    const rows = await this.facts.windowTransfers(account, occMs, HOUR);
    const times = new Map(rows.map(row => [row.id, row.atMs]));
    if (!times.has(event.transferId)) times.set(event.transferId, occMs);
    const entries = [...times].map(([member, atMs]) => ({ member, atMs }));
    if (state && !this.generationStale) {
      await this.attempt('R1', () => this.velocity.seed(account, state.gen, entries, hourFrom));
    }
    return {
      tenMinutes: entries.filter(entry => entry.atMs >= tenFrom && entry.atMs <= occMs).length,
      hour: entries.filter(entry => entry.atMs >= hourFrom && entry.atMs <= occMs).length,
    };
  }

  /** R5: recipients that were new to the source account, first paid in `(occ - 1h, occ]`. */
  private async countNewRecipients(event: TransferEvent, occMs: number): Promise<number> {
    const account = event.fromAccountId;
    const hourFrom = occMs - HOUR + 1;
    const state = await this.attempt('R5', async () => {
      await this.trusted(this.fanOut);
      return this.fanOut.lookup(account, hourFrom);
    });
    if (state?.covered) {
      const isNew = await this.facts.isNewRecipient(
        account,
        event.toAccountId,
        event.transferId,
        occMs,
      );
      const count = await this.attempt('R5', async () => {
        if (isNew) await this.fanOut.add(account, event.toAccountId, occMs);
        return this.fanOut.count(account, hourFrom, occMs);
      });
      if (count !== undefined) return count;
    } else if (state) {
      this.metrics.redisFallback('R5', 'cold');
    }

    const recipients = await this.facts.newRecipientsInWindow(account, occMs, HOUR);
    if (state && !this.generationStale) {
      const entries = recipients.map(r => ({ member: r.recipientId, atMs: r.atMs }));
      await this.attempt('R5', () => this.fanOut.seed(account, state.gen, entries, hourFrom));
    }
    return recipients.length;
  }
}
