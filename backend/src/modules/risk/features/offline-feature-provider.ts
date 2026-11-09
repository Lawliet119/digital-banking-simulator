import { toAiFeatureInput } from '../ai/feature-projection';
import type { FeatureInput } from '../ai/ai-contract';
import { riskTimeNanoseconds } from '../risk-time';
import type { FeatureProvider, Features, TransferEvent } from './feature-provider';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A completed TRANSFER fact, not an event snapshot. Include the full available history.
 * createdAt is the SQL created_at timestamp (sub-millisecond precision is accepted).
 * Status/type filtering must happen before constructing this provider. */
export interface OfflineTransferFact {
  readonly id: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly createdAt: string;
  readonly amount: string;
}

type Fact = Readonly<OfflineTransferFact & { ms: number; money: bigint }>;
type Base = Omit<Features, 'reverseTransferOccurredAt'>;
const millis = (at: string): number => {
  const nanos = riskTimeNanoseconds(at);
  // BigInt division truncates toward zero; SQL/Date truncate the timestamp to the prior millisecond.
  return Number(nanos / 1_000_000n - (nanos < 0n && nanos % 1_000_000n !== 0n ? 1n : 0n));
};
const pairKey = (from: string, to: string): string => JSON.stringify([from, to]);

function lower(rows: readonly Fact[], ms: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].ms < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Coordinate-compressed order statistics: exact bigint median, O(log n) updates/select. */
class AmountRanks {
  private readonly tree: number[];
  private readonly ranks: Map<bigint, number>;
  constructor(readonly values: bigint[]) {
    this.tree = Array<number>(values.length + 1).fill(0);
    this.ranks = new Map(values.map((v, i) => [v, i + 1]));
  }
  add(value: bigint, delta: number): void {
    for (let i = this.ranks.get(value)!; i < this.tree.length; i += i & -i) this.tree[i] += delta;
  }
  select(rank: number): bigint {
    let index = 0;
    let step = 1;
    while (step * 2 < this.tree.length) step *= 2;
    for (; step; step = Math.floor(step / 2)) {
      const next = index + step;
      if (next < this.tree.length && this.tree[next] < rank) {
        index = next;
        rank -= this.tree[next];
      }
    }
    return this.values[index];
  }
}

/** Eager O(n log n) indexing, O(n) space; extraction order never mutates feature state.
 * Events must correspond to supplied facts. Missing facts are rejected, not synthesized.
 * All facts in a millisecond are visible together, exactly as TransferFacts SQL windows.
 */
export class OfflineFeatureProvider implements FeatureProvider {
  private readonly facts = new Map<string, Fact>();
  private readonly pairs = new Map<string, Fact[]>();
  private readonly features = new Map<string, Base>();

  constructor(
    input: readonly OfflineTransferFact[],
    private readonly perTxLimit: bigint,
  ) {
    if (perTxLimit < 0n) throw new Error('Invalid per-transfer limit');
    const accounts = new Map<string, Fact[]>();
    for (const source of input) {
      if (
        !source.id ||
        !source.fromAccountId ||
        !source.toAccountId ||
        !/^[1-9]\d*$/.test(source.amount)
      ) {
        throw new Error('Invalid completed transfer fact');
      }
      const fact: Fact = Object.freeze({
        ...source,
        ms: millis(source.createdAt),
        money: BigInt(source.amount),
      });
      const previous = this.facts.get(fact.id);
      if (previous) {
        if (
          previous.fromAccountId !== fact.fromAccountId ||
          previous.toAccountId !== fact.toAccountId ||
          previous.money !== fact.money ||
          riskTimeNanoseconds(previous.createdAt) !== riskTimeNanoseconds(fact.createdAt)
        ) {
          throw new Error(`Conflicting transfer fact: ${fact.id}`);
        }
        continue;
      }
      this.facts.set(fact.id, fact);
      const account = accounts.get(fact.fromAccountId) ?? [];
      account.push(fact);
      accounts.set(fact.fromAccountId, account);
      const key = pairKey(fact.fromAccountId, fact.toAccountId);
      const pair = this.pairs.get(key) ?? [];
      pair.push(fact);
      this.pairs.set(key, pair);
    }
    for (const rows of this.pairs.values()) rows.sort((a, b) => a.ms - b.ms);
    for (const rows of accounts.values()) this.indexAccount(rows);
  }

  private indexAccount(rows: Fact[]): void {
    rows.sort((a, b) => a.ms - b.ms || a.id.localeCompare(b.id));
    const ranks = new AmountRanks(
      [...new Set(rows.map(r => r.money))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    let historyLeft = 0;
    let historyRight = 0;
    let hourLeft = 0;
    let tenLeft = 0;
    let dayLeft = 0;
    let sum = 0n;
    let small = 0;
    let novelCount = 0;
    const recipients = new Map<string, number>();
    const hourPairs = new Map<string, { indices: number[]; head: number }>();
    const novel: boolean[] = [];
    const lastTime = new Map<string, number>();
    for (let start = 0; start < rows.length;) {
      const at = rows[start].ms;
      let end = start;
      while (end < rows.length && rows[end].ms === at) end++;
      while (historyRight < start) ranks.add(rows[historyRight++].money, 1);
      while (historyLeft < start && rows[historyLeft].ms < at - 30 * DAY)
        ranks.add(rows[historyLeft++].money, -1);
      const historyCount = start - historyLeft;
      for (let i = start; i < end; i++) {
        const row = rows[i];
        const previous = lastTime.get(row.toAccountId);
        novel[i] = previous === undefined || previous < at - 30 * DAY;
        const queue = hourPairs.get(row.toAccountId) ?? { indices: [], head: 0 };
        if (queue.head === queue.indices.length && novel[i]) novelCount++;
        queue.indices.push(i);
        hourPairs.set(row.toAccountId, queue);
        sum += row.money;
        if (row.money * 10n < this.perTxLimit) small++;
        recipients.set(row.toAccountId, (recipients.get(row.toAccountId) ?? 0) + 1);
      }
      for (let i = start; i < end; i++) lastTime.set(rows[i].toAccountId, at);
      while (hourLeft < end && rows[hourLeft].ms <= at - HOUR) {
        const queue = hourPairs.get(rows[hourLeft].toAccountId)!;
        if (novel[queue.indices[queue.head]]) novelCount--;
        queue.head++;
        if (queue.head < queue.indices.length && novel[queue.indices[queue.head]]) novelCount++;
        hourLeft++;
      }
      while (tenLeft < end && rows[tenLeft].ms <= at - 600_000) tenLeft++;
      while (dayLeft < end && rows[dayLeft].ms <= at - DAY) {
        const row = rows[dayLeft++];
        sum -= row.money;
        if (row.money * 10n < this.perTxLimit) small--;
        const count = recipients.get(row.toAccountId)! - 1;
        if (count) recipients.set(row.toAccountId, count);
        else recipients.delete(row.toAccountId);
      }
      const base: Base = Object.freeze({
        txCount10m: end - tenLeft,
        txCount1h: end - hourLeft,
        historyCount30d: historyCount,
        medianAmount30dTimes2:
          historyCount < 5
            ? null
            : String(
                ranks.select(Math.floor((historyCount + 1) / 2)) +
                  ranks.select(Math.floor((historyCount + 2) / 2)),
              ),
        newRecipients1h: novelCount,
        distinctRecipients24h: recipients.size,
        sumOut24h: String(sum),
        smallTxCount24h: small,
      });
      for (let i = start; i < end; i++) this.features.set(rows[i].id, base);
      start = end;
    }
  }

  // An indexed lookup is synchronous but must implement the async FeatureProvider contract.
  // eslint-disable-next-line @typescript-eslint/require-await
  async extract(event: TransferEvent): Promise<Features> {
    const fact = this.facts.get(event.transferId);
    const at = millis(event.occurredAt);
    if (
      !fact ||
      fact.ms !== at ||
      fact.fromAccountId !== event.fromAccountId ||
      fact.toAccountId !== event.toAccountId ||
      fact.amount !== event.amount
    ) {
      throw new Error('Event does not match a supplied completed transfer fact');
    }
    const reverse = this.pairs.get(pairKey(event.toAccountId, event.fromAccountId)) ?? [];
    const index = lower(reverse, at) - 1;
    const previous = reverse[index];
    return {
      ...this.features.get(fact.id)!,
      reverseTransferOccurredAt:
        previous && previous.ms >= at - HOUR ? new Date(previous.ms).toISOString() : null,
    };
  }

  /** Only the existing eleven-field allowlist; no ids, labels or raw event metadata. */
  async extractAiInput(event: TransferEvent): Promise<FeatureInput> {
    return toAiFeatureInput(event, await this.extract(event));
  }
}
