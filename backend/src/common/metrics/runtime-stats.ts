import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { metricsConfig } from '@config/metrics.config';
import { MetricsService } from './metrics.service';

/**
 * How often the event loop is sampled. The histogram reports the time between two samples, so an idle loop reads
 * about this value; `takeSnapshot` subtracts it and reports only the delay beyond it.
 */
export const LOOP_RESOLUTION_MS = 10;

/** What one task's runtime did since the last read (BL-419). `null`: nothing was seen in the interval. */
export interface RuntimeSnapshot {
  /** 99th percentile of the event loop delay, ms beyond the sampling interval. */
  loopP99Ms: number | null;
  /** Longest event loop delay, ms beyond the sampling interval. */
  loopMaxMs: number | null;
  /** Longest garbage collection pause, ms. */
  gcMaxMs: number | null;
}

/**
 * Event loop delay and garbage collection pauses of THIS process. BL-419 asks where the stalls of one or two seconds
 * come from (the database was idle, the application logged nothing): a blocked event loop or a long collection in one
 * task would explain them, and neither shows in any metric the application had. Reading takes the numbers of the
 * interval and starts the next one empty, so a flush reports exactly the time since the previous flush.
 */
export class RuntimeStats {
  private histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
  private observer: PerformanceObserver | undefined;
  private gcMaxMs: number | null = null;

  start(): void {
    if (this.histogram) return;
    this.histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    this.histogram.enable();
    this.observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (this.gcMaxMs === null || entry.duration > this.gcMaxMs) this.gcMaxMs = entry.duration;
      }
    });
    this.observer.observe({ entryTypes: ['gc'] });
  }

  stop(): void {
    this.histogram?.disable();
    this.observer?.disconnect();
    this.histogram = undefined;
    this.observer = undefined;
    this.gcMaxMs = null;
  }

  takeSnapshot(): RuntimeSnapshot {
    const histogram = this.histogram;
    // Entries the observer has not delivered yet are picked up by the next read: a pause is never lost, only late.
    const gcMaxMs = this.gcMaxMs;
    this.gcMaxMs = null;
    if (!histogram || histogram.count === 0) return { loopP99Ms: null, loopMaxMs: null, gcMaxMs };
    const beyond = (nanoseconds: number) => Math.max(0, nanoseconds / 1e6 - LOOP_RESOLUTION_MS);
    const snapshot = {
      loopP99Ms: beyond(histogram.percentile(99)),
      loopMaxMs: beyond(histogram.max),
      gcMaxMs,
    };
    // reset() also forgets the time of the last sample, so a block that straddles this call (about one sampling
    // interval per flush, 10 ms of 60 s) is not recorded: accepted, the gauges look for stalls of a second or more.
    histogram.reset();
    return snapshot;
  }
}

/** The metric names, in the order the gauges are read: the first one takes the snapshot the other two use. */
export const RUNTIME_GAUGE_NAMES = [
  'event_loop_delay_p99_ms',
  'event_loop_delay_max_ms',
  'gc_pause_max_ms',
];

/**
 * Registers the three runtime gauges on `MetricsService` (BL-419). Every task writes them to ITS OWN log stream
 * (`api/api/<task id>`), so a stall can be tied to one task with Logs Insights, for example
 * `filter ispresent(event_loop_delay_max_ms) | stats max(event_loop_delay_max_ms) by @logStream, bin(1m)`; the
 * metric in `DBS/Backend` (no dimension, like `outbox_oldest_unpublished_age_seconds`) shows the worst task.
 * Switched off with the rest of the metrics: no sampling timer, no observer, no line.
 */
@Injectable()
export class RuntimeGauges implements OnModuleInit, OnApplicationShutdown {
  private snapshot: RuntimeSnapshot = { loopP99Ms: null, loopMaxMs: null, gcMaxMs: null };

  constructor(
    private readonly metrics: MetricsService,
    @Inject(metricsConfig.KEY) private readonly config: ConfigType<typeof metricsConfig>,
    // A test injects its own; in the application it is not a provider, so Nest passes `undefined` and the default applies.
    @Optional() private readonly stats: RuntimeStats = new RuntimeStats(),
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) return;
    this.stats.start();
    // `MetricsService` reads the gauges one after the other in registration order and awaits each one, so the first
    // read takes the snapshot (and starts the next interval) and the other two report the same snapshot.
    this.metrics.registerGauge({
      name: RUNTIME_GAUGE_NAMES[0],
      unit: 'Milliseconds',
      read: () => {
        this.snapshot = this.stats.takeSnapshot();
        return Promise.resolve(this.snapshot.loopP99Ms);
      },
    });
    this.metrics.registerGauge({
      name: RUNTIME_GAUGE_NAMES[1],
      unit: 'Milliseconds',
      read: () => Promise.resolve(this.snapshot.loopMaxMs),
    });
    this.metrics.registerGauge({
      name: RUNTIME_GAUGE_NAMES[2],
      unit: 'Milliseconds',
      read: () => Promise.resolve(this.snapshot.gcMaxMs),
    });
  }

  onApplicationShutdown(): void {
    this.stats.stop();
  }
}
