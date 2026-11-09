/**
 * Upper bounds of the latency buckets, in milliseconds. The SLO thresholds of docs/03 §14 (150 ms
 * for reads, 300 ms and 1 s for transfers) are bounds, so a comparison with them is exact. A
 * percentile read from these buckets is the upper bound of the bucket it falls in: it is never
 * lower than the real one, so an alarm on `GreaterThanThreshold` cannot miss a breach.
 */
export const LATENCY_BOUNDS_MS = [
  1, 2, 5, 10, 20, 50, 100, 150, 200, 300, 500, 1000, 2000, 5000, 10_000, 60_000,
];

/** Most samples one drain gives out; more are scaled down in proportion (see `drain`). */
export const MAX_DRAIN_SAMPLES = 10_000;

export interface DrainedLatency {
  /** One value per sample: the upper bound of its bucket, ascending. */
  samples: number[];
  /** The real number of requests measured, before any scaling. */
  total: number;
}

/**
 * Memory is one counter per bucket, however many requests come. CloudWatch wants an array with a
 * value per sample, so `drain` spells the buckets out again.
 */
export class LatencyHistogram {
  private counts = new Array<number>(LATENCY_BOUNDS_MS.length).fill(0);

  get count(): number {
    return this.counts.reduce((a, b) => a + b, 0);
  }

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const index = LATENCY_BOUNDS_MS.findIndex(bound => ms <= bound);
    this.counts[index === -1 ? LATENCY_BOUNDS_MS.length - 1 : index] += 1;
  }

  /**
   * Gives the samples and empties the histogram. Above `maxSamples` every bucket is scaled by the
   * same factor (rounded, at least one while it holds anything), which keeps the shape of the
   * distribution, hence its percentiles, and keeps a rare slow request visible.
   */
  drain(maxSamples = MAX_DRAIN_SAMPLES): DrainedLatency {
    const total = this.count;
    const factor = total > maxSamples ? maxSamples / total : 1;
    const samples: number[] = [];
    this.counts.forEach((count, i) => {
      if (count === 0) return;
      const n = factor === 1 ? count : Math.max(1, Math.round(count * factor));
      for (let k = 0; k < n; k++) samples.push(LATENCY_BOUNDS_MS[i]);
    });
    this.counts = new Array<number>(LATENCY_BOUNDS_MS.length).fill(0);
    return { samples, total };
  }
}
