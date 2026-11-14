import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import type { RequestHandler } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { Counter, register } from 'prom-client';
import { appConfig } from '@config/app.config';
import { metricsConfig } from '@config/metrics.config';
import {
  buildEmf,
  splitSamples,
  type EmfDimensionName,
  type EmfDocument,
  type EmfSpec,
  type EmfUnit,
} from './emf';
import { createHttpMetricsMiddleware } from './http-metrics.middleware';
import { HttpStats, toEmfSpecs } from './http-stats';
import { LatencyHistogram } from './latency-histogram';

/** Where finished EMF lines go; a test injects its own. The default is the application logger. */
export const EMF_SINK = 'EMF_SINK';
export type EmfSink = (doc: EmfDocument) => void;

/** How long one flush waits for a gauge; the rest of the flush has already been written. */
export const GAUGE_TIMEOUT_MS = 3_000;

export interface Gauge {
  /** Metric name, also the key: a gauge is read at most once at a time. */
  name: string;
  unit: EmfUnit;
  /** The value now, or `null` when there is nothing to report. */
  read: () => Promise<number | null>;
}

interface CounterSpec {
  /** Name in the prom-client default registry; also the name of the EMF metric. */
  name: string;
  /** Label of the counter -> dimension of the metric. */
  labels: Record<string, EmfDimensionName>;
  /**
   * Also publish the total without the labels (`Role` alone) next to the per-label series, in the
   * same line: an alarm watches the total, the dashboard splits it. The line carries the number
   * once; CloudWatch aggregates it into both metrics.
   */
  roleTotal?: boolean;
}

/**
 * The counters that become metrics. A counter is not exported just because it exists: every
 * label is a dimension, so each one is listed here, and none can hold data about a person.
 */
const COUNTERS: CounterSpec[] = [
  { name: 'redis_fallback_total', labels: {} },
  { name: 'rate_limited_total', labels: { scope: 'Scope' } },
  { name: 'risk_redis_fallback_total', labels: { rule: 'Rule', reason: 'Reason' } },
  { name: 'risk_config_redis_fallback_total', labels: { reason: 'Reason' }, roleTotal: true },
  // BL-204/BL-207/BL-046: the scoring half of risk. Every label value is one of a fixed set (rule
  // R1..R6, an `ai_status` of the schema), enforced where the counter is incremented.
  { name: 'risk_rule_error_total', labels: { rule: 'Rule' } },
  { name: 'risk_decision_total', labels: { ai_status: 'AiStatus' } },
  // BL-127: one increment per reconciliation run that was recorded; `status` is OK, MISMATCH or ERROR.
  { name: 'reconciliation_runs_total', labels: { status: 'Status' } },
  // BL-209: a message a queue consumer retried or dead-lettered. `consumer` is a literal of the code
  // (risk, notification) and `outcome` is retry or dead_letter, both checked where it is counted.
  { name: 'consumer_message_total', labels: { consumer: 'Consumer', outcome: 'Outcome' } },
];

/**
 * Distributions a module may feed with `recordDistribution` (BL-204). Each one is a latency in
 * milliseconds, written per flush as samples (at most 100 per EMF line) under the dimension
 * `Role`. A name is listed here, not made up by the caller, so no label or metric can hold data
 * about a person.
 */
export const DISTRIBUTION_METRICS = [
  'risk_transfer_to_flag_ms',
  'risk_ai_call_duration_ms',
] as const;
export type DistributionMetric = (typeof DISTRIBUTION_METRICS)[number];

const PASS_THROUGH: RequestHandler = (_req, _res, next) => next();

/**
 * Turns what the process already counts into CloudWatch metrics (DBS-144, docs/03 §14): HTTP
 * latency and errors per route, the prom-client counters on the list above, and the gauges that
 * modules register. Every `METRICS_FLUSH_MS` it writes one EMF line per group through the
 * application logger; the `awslogs` driver and CloudWatch do the rest. Switched off, it does
 * nothing: no listener on a request, no timer, no line.
 */
@Injectable()
export class MetricsService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly stats = new HttpStats();
  private readonly logger = new Logger(MetricsService.name);
  private readonly gauges: Gauge[] = [];
  /** Gauges whose last read has not finished: never read twice at once. */
  private readonly pending = new Set<string>();
  /** Latencies recorded since the last flush; same buckets as HTTP, so memory does not grow. */
  private readonly distributions = new Map<DistributionMetric, LatencyHistogram>(
    DISTRIBUTION_METRICS.map(name => [name, new LatencyHistogram()]),
  );
  private baseline = new Map<string, number>();
  private intervalStart = 0;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private emfLogger: { info: (doc: object) => void } | undefined;

  constructor(
    @Inject(metricsConfig.KEY) private readonly config: ConfigType<typeof metricsConfig>,
    @Inject(appConfig.KEY) private readonly app: ConfigType<typeof appConfig>,
    private readonly pino: PinoLogger,
    @Optional() @Inject(EMF_SINK) private readonly sink?: EmfSink,
  ) {}

  httpMiddleware(): RequestHandler {
    return this.config.enabled ? createHttpMetricsMiddleware(this.stats) : PASS_THROUGH;
  }

  registerGauge(gauge: Gauge): void {
    this.gauges.push(gauge);
  }

  /**
   * Adds one latency (milliseconds) to a distribution; the next flush writes it. A percentile of
   * the result is the upper bound of the bucket it falls in (see `LatencyHistogram`), never lower
   * than the real one. Switched off, it does nothing, like the HTTP middleware.
   */
  recordDistribution(name: DistributionMetric, milliseconds: number): void {
    if (!this.config.enabled) return;
    this.distributions.get(name)?.record(milliseconds);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.start();
  }

  /** Takes the baseline of the counters (they are shared by the whole process) and arms the timer. */
  async start(now: number = Date.now()): Promise<void> {
    if (!this.config.enabled || this.timer) return;
    this.intervalStart = now;
    this.baseline = new Map((await this.readCounters()).map(c => [c.key, c.value]));
    this.timer = setInterval(() => void this.flush(), this.config.flushMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.config.enabled) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // The database may already be closed by now (Nest does not order the hooks of two modules),
    // so the last flush leaves the gauges out.
    await this.flush(Date.now(), false);
    await this.flushOutput();
  }

  flush(now: number = Date.now(), withGauges = true): Promise<void> {
    if (!this.config.enabled) return Promise.resolve();
    if (this.running) return this.running;
    const run = this.write(now, withGauges).finally(() => {
      this.running = undefined;
    });
    this.running = run;
    return run;
  }

  private async write(now: number, withGauges: boolean): Promise<void> {
    const timestamp = this.intervalStart || now;
    this.intervalStart = now;
    try {
      for (const group of this.stats.drain()) {
        for (const spec of toEmfSpecs(group, timestamp)) this.emit(spec, now);
      }
      this.writeDistributions(timestamp, now);
      await this.writeCounters(timestamp, now);
      if (withGauges) await this.writeGauges(now);
    } catch (error) {
      this.logger.warn({ errorName: errorName(error) }, 'Metric flush failed');
    }
  }

  private writeDistributions(timestamp: number, now: number): void {
    for (const [name, histogram] of this.distributions) {
      for (const piece of splitSamples(histogram.drain().samples)) {
        this.emit(
          {
            timestamp,
            dimensions: { Role: this.app.role },
            dimensionSets: [['Role']],
            metrics: [{ name, unit: 'Milliseconds', value: piece }],
          },
          now,
        );
      }
    }
  }

  private async writeCounters(timestamp: number, now: number): Promise<void> {
    const dimensionSets = (labels: EmfDimensionName[], total: boolean): EmfDimensionName[][] => [
      ['Role', ...labels],
      ...(total && labels.length > 0 ? [['Role'] as EmfDimensionName[]] : []),
    ];
    for (const counter of await this.readCounters()) {
      const before = this.baseline.get(counter.key) ?? 0;
      this.baseline.set(counter.key, counter.value);
      const delta = counter.value - before;
      // A counter that went down was reset; it counts again from its new value.
      if (delta <= 0) continue;
      const dimensions: EmfSpec['dimensions'] = { Role: this.app.role, ...counter.dimensions };
      this.emit(
        {
          timestamp,
          dimensions,
          dimensionSets: dimensionSets(
            Object.keys(counter.dimensions) as EmfDimensionName[],
            counter.roleTotal,
          ),
          metrics: [{ name: counter.name, unit: 'Count', value: delta }],
        },
        now,
      );
    }
  }

  private async writeGauges(now: number): Promise<void> {
    for (const gauge of this.gauges) {
      if (this.pending.has(gauge.name)) {
        this.logger.warn({ gauge: gauge.name, reason: 'still reading' }, 'Metric gauge skipped');
        continue;
      }
      let value: number | null;
      try {
        value = await this.readGauge(gauge);
      } catch (error) {
        const reason = error instanceof GaugeTimeout ? 'timeout' : 'error';
        this.logger.warn(
          { gauge: gauge.name, reason, errorName: errorName(error) },
          'Metric gauge not read',
        );
        continue;
      }
      if (value === null) continue;
      this.emit(
        {
          timestamp: now,
          dimensions: {},
          dimensionSets: [[]],
          metrics: [{ name: gauge.name, unit: gauge.unit, value }],
        },
        now,
      );
    }
  }

  private readGauge(gauge: Gauge): Promise<number | null> {
    const read = gauge.read().finally(() => this.pending.delete(gauge.name));
    this.pending.add(gauge.name);
    // A read that fails after the wait has ended must not become an unhandled rejection.
    read.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new GaugeTimeout()), GAUGE_TIMEOUT_MS);
      timer.unref();
    });
    return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
  }

  private async readCounters(): Promise<
    {
      key: string;
      name: string;
      value: number;
      dimensions: EmfSpec['dimensions'];
      roleTotal: boolean;
    }[]
  > {
    const found: {
      key: string;
      name: string;
      value: number;
      dimensions: EmfSpec['dimensions'];
      roleTotal: boolean;
    }[] = [];
    for (const spec of COUNTERS) {
      const metric = register.getSingleMetric(spec.name);
      if (!(metric instanceof Counter)) continue;
      for (const sample of (await metric.get()).values) {
        const dimensions: EmfSpec['dimensions'] = {};
        for (const [label, dimension] of Object.entries(spec.labels)) {
          const value = sample.labels[label];
          if (value !== undefined) dimensions[dimension] = String(value);
        }
        found.push({
          key: `${spec.name}|${JSON.stringify(dimensions)}`,
          name: spec.name,
          value: sample.value,
          dimensions,
          roleTotal: spec.roleTotal === true,
        });
      }
    }
    return found;
  }

  private emit(spec: EmfSpec, now: number): void {
    try {
      const doc = buildEmf(spec, now);
      if (this.sink) this.sink(doc);
      else this.logOut().info(doc);
    } catch (error) {
      // buildEmf names metrics and dimensions in its messages, never a value.
      this.logger.warn(
        { metric: spec.metrics.map(m => m.name), errorName: errorName(error) },
        'Metric line not written',
      );
    }
  }

  /** A child at info level, so a quiet LOG_LEVEL does not silence the metrics. */
  private logOut(): { info: (doc: object) => void } {
    this.emfLogger ??= this.pino.logger.child({}, { level: 'info' });
    return this.emfLogger;
  }

  private async flushOutput(): Promise<void> {
    if (this.sink) return;
    try {
      await new Promise<void>(resolve => {
        this.pino.logger.flush(() => resolve());
      });
    } catch {
      // Best effort: a stream that cannot flush has nothing left to lose here.
    }
  }
}

class GaugeTimeout extends Error {
  constructor() {
    super('gauge read timed out');
    this.name = 'GaugeTimeout';
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
