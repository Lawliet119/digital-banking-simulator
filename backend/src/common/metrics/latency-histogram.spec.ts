import { LATENCY_BOUNDS_MS, LatencyHistogram } from './latency-histogram';

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

describe('LatencyHistogram', () => {
  it('TC-144-03 puts a sample on the bucket whose upper bound is not below it', () => {
    const h = new LatencyHistogram();
    h.record(300);
    h.record(301);
    h.record(0.2);
    h.record(70_000);
    expect(h.drain().samples).toEqual([1, 300, 500, 60_000]);
  });

  it('TC-144-03 the SLO thresholds 150 ms, 300 ms and 1 s are bucket bounds', () => {
    for (const threshold of [150, 300, 1000]) expect(LATENCY_BOUNDS_MS).toContain(threshold);
  });

  it('TC-144-03 gives the samples in ascending order and counts them', () => {
    const h = new LatencyHistogram();
    for (const ms of [90, 12, 12, 250, 3]) h.record(ms);
    const { samples, total } = h.drain();
    expect(total).toBe(5);
    expect(samples).toEqual([5, 20, 20, 100, 300]);
  });

  it('TC-144-03 is empty after a drain', () => {
    const h = new LatencyHistogram();
    h.record(10);
    h.drain();
    expect(h.drain()).toEqual({ samples: [], total: 0 });
    expect(h.count).toBe(0);
  });

  it('TC-144-03 ignores a sample that is not a finite non-negative number', () => {
    const h = new LatencyHistogram();
    h.record(Number.NaN);
    h.record(-5);
    h.record(Number.POSITIVE_INFINITY);
    expect(h.count).toBe(0);
  });

  it('TC-144-03 above the cap it scales the buckets and keeps the p95 and p99', () => {
    const h = new LatencyHistogram();
    const real: number[] = [];
    for (let i = 0; i < 30_000; i++) {
      const ms = i % 100 < 96 ? 40 : 800;
      h.record(ms);
      real.push(ms <= 50 ? 50 : 1000);
    }
    const { samples, total } = h.drain(10_000);
    expect(total).toBe(30_000);
    expect(samples.length).toBeLessThanOrEqual(10_000 + LATENCY_BOUNDS_MS.length);
    expect(percentile(samples, 95)).toBe(percentile(real, 95));
    expect(percentile(samples, 99)).toBe(percentile(real, 99));
  });

  it('TC-144-03 keeps a rare slow request when it scales', () => {
    const h = new LatencyHistogram();
    for (let i = 0; i < 50_000; i++) h.record(10);
    h.record(5000);
    expect(h.drain(1000).samples).toContain(5000);
  });
});
