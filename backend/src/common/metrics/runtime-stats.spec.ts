import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { appConfig } from '@config/app.config';
import { metricsConfig } from '@config/metrics.config';
import type { EmfDocument } from './emf';
import { EMF_SINK, MetricsService } from './metrics.service';
import {
  RUNTIME_GAUGE_NAMES,
  RuntimeGauges,
  RuntimeStats,
  type RuntimeSnapshot,
} from './runtime-stats';

/** Blocks the event loop on purpose: the thing the tail of BL-419 may be made of. */
function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* spin */
  }
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('RuntimeStats (BL-419: event loop delay and GC pauses of one task)', () => {
  let stats: RuntimeStats;
  beforeEach(() => {
    stats = new RuntimeStats();
    stats.start();
  });
  afterEach(() => stats.stop());

  it('TC-419-01 reports a blocked event loop as delay beyond the sampling interval, and the next read starts empty', async () => {
    await pause(30);
    block(150);
    await pause(30);
    const first = stats.takeSnapshot();
    expect(first.loopMaxMs).toBeGreaterThanOrEqual(120); // the 150 ms block minus the 10 ms interval, with margin
    expect(first.loopP99Ms).not.toBeNull();
    expect(first.loopP99Ms!).toBeLessThanOrEqual(first.loopMaxMs! + 1);
    await pause(40);
    const second = stats.takeSnapshot();
    // the spike was taken with the first read
    expect(second.loopMaxMs === null || second.loopMaxMs < 100).toBe(true);
  });

  it('TC-419-02 an idle loop reports a small delay, never a negative one', async () => {
    await pause(60);
    const snapshot = stats.takeSnapshot();
    expect(snapshot.loopMaxMs).not.toBeNull();
    expect(snapshot.loopMaxMs!).toBeGreaterThanOrEqual(0);
    expect(snapshot.loopMaxMs!).toBeLessThan(100);
  });

  it('TC-419-03 sees the garbage collections a burst of allocation causes, longest one first', async () => {
    let seen: number | null = null;
    for (let round = 0; round < 40 && seen === null; round++) {
      const garbage: unknown[] = [];
      for (let i = 0; i < 200_000; i++) garbage.push({ i, text: `item-${i}` });
      garbage.length = 0;
      await pause(20); // the observer delivers its entries after the allocation, not during it
      seen = stats.takeSnapshot().gcMaxMs;
    }
    expect(seen).not.toBeNull();
    expect(seen!).toBeGreaterThan(0);
  });

  it('TC-419-04 after stop() there is nothing to report and a second stop() is harmless', async () => {
    block(60);
    await pause(10);
    stats.stop();
    stats.stop();
    expect(stats.takeSnapshot()).toEqual({ loopP99Ms: null, loopMaxMs: null, gcMaxMs: null });
  });
});

describe('RuntimeGauges (the three gauges of BL-419 on MetricsService)', () => {
  const snapshot: RuntimeSnapshot = { loopP99Ms: 12.5, loopMaxMs: 1900, gcMaxMs: 41 };

  function make(enabled: boolean, fake?: Partial<RuntimeStats>) {
    const docs: EmfDocument[] = [];
    const metrics = new MetricsService(
      { enabled, flushMs: 60_000 },
      { role: 'api' } as never,
      doc => docs.push(doc),
    );
    const stats = {
      start: jest.fn(),
      stop: jest.fn(),
      takeSnapshot: jest.fn(() => snapshot),
      ...fake,
    } as unknown as RuntimeStats;
    const gauges = new RuntimeGauges(metrics, { enabled, flushMs: 60_000 }, stats);
    return { metrics, gauges, stats, docs };
  }
  const nameOf = (doc: EmfDocument) => doc._aws.CloudWatchMetrics[0].Metrics[0].Name;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('TC-419-05 a flush writes the three metrics, each in Milliseconds, from ONE snapshot taken by the first gauge', async () => {
    const { metrics, gauges, stats, docs } = make(true);
    gauges.onModuleInit();
    await metrics.flush();
    const written = docs.filter(doc => RUNTIME_GAUGE_NAMES.includes(nameOf(doc)));
    expect(written.map(nameOf)).toEqual([
      'event_loop_delay_p99_ms',
      'event_loop_delay_max_ms',
      'gc_pause_max_ms',
    ]);
    expect(written.map(doc => doc._aws.CloudWatchMetrics[0].Metrics[0].Unit)).toEqual([
      'Milliseconds',
      'Milliseconds',
      'Milliseconds',
    ]);
    expect(written.map(doc => doc[nameOf(doc)])).toEqual([12.5, 1900, 41]);
    expect(stats.takeSnapshot).toHaveBeenCalledTimes(1);
    expect(stats.start).toHaveBeenCalledTimes(1);
  });

  it('TC-419-05 a metric with nothing to report is left out, the others are still written', async () => {
    const { metrics, gauges, docs } = make(true, {
      takeSnapshot: () => ({ loopP99Ms: 3, loopMaxMs: 4, gcMaxMs: null }),
    });
    gauges.onModuleInit();
    await metrics.flush();
    expect(docs.map(nameOf)).toEqual(['event_loop_delay_p99_ms', 'event_loop_delay_max_ms']);
  });

  it('TC-419-06 switched off: no monitor is started and no gauge is registered', async () => {
    const { metrics, gauges, stats, docs } = make(false);
    gauges.onModuleInit();
    await metrics.flush();
    expect(stats.start).not.toHaveBeenCalled();
    expect(docs).toEqual([]);
  });

  it('TC-419-06 the monitors are stopped when the application shuts down', () => {
    const { gauges, stats } = make(true);
    gauges.onModuleInit();
    gauges.onApplicationShutdown();
    expect(stats.stop).toHaveBeenCalledTimes(1);
  });

  it('TC-419-07 Nest builds RuntimeGauges from the real providers (its stats argument is optional), starts it on init and stops it on shutdown', async () => {
    const docs: EmfDocument[] = [];
    const module = await Test.createTestingModule({
      providers: [
        MetricsService,
        RuntimeGauges,
        { provide: metricsConfig.KEY, useValue: { enabled: true, flushMs: 60_000 } },
        { provide: appConfig.KEY, useValue: { role: 'api' } },
        { provide: EMF_SINK, useValue: (doc: EmfDocument) => docs.push(doc) },
      ],
    }).compile();
    try {
      await module.init();
      block(40);
      await pause(30);
      await module.get(MetricsService).flush();
      const names = docs.map(nameOf);
      expect(names).toEqual(
        expect.arrayContaining(['event_loop_delay_p99_ms', 'event_loop_delay_max_ms']),
      );
    } finally {
      await module.close();
    }
  });
});
