import { Logger } from '@nestjs/common';
import { Counter, register } from 'prom-client';
import type { EmfDocument } from './emf';
import { MetricsService } from './metrics.service';

const T0 = Date.UTC(2026, 10, 9, 11, 0, 0);
const MINUTE = 60_000;
const COUNTERS = [
  'redis_fallback_total',
  'rate_limited_total',
  'risk_redis_fallback_total',
  'risk_config_redis_fallback_total',
  'risk_unsupported_mode_total',
  'risk_rule_error_total',
  'risk_decision_total',
  'reconciliation_runs_total',
];

function counter(name: string, labelNames: string[] = []): Counter {
  return new Counter({ name, help: name, labelNames, registers: [register] });
}

interface Made {
  service: MetricsService;
  docs: EmfDocument[];
  child: jest.Mock;
  flushLogger: jest.Mock;
}

function make(enabled = true, sink?: (doc: EmfDocument) => void, role = 'api'): Made {
  const docs: EmfDocument[] = [];
  const info = jest.fn((doc: EmfDocument) => docs.push(doc));
  const child = jest.fn(() => ({ info }));
  const flushLogger = jest.fn((cb: () => void) => cb());
  const pino = { logger: { child, flush: flushLogger } };
  const service = new MetricsService(
    { enabled, flushMs: MINUTE },
    { role } as never,
    pino as never,
    sink,
  );
  return { service, docs, child, flushLogger };
}

function collect(): { service: MetricsService; docs: EmfDocument[] } {
  const docs: EmfDocument[] = [];
  const { service } = make(true, doc => docs.push(doc));
  return { service, docs };
}

function names(doc: EmfDocument): string[] {
  return doc._aws.CloudWatchMetrics[0].Metrics.map(m => m.Name);
}

describe('MetricsService', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    for (const name of COUNTERS) register.removeSingleMetric(name);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    for (const name of COUNTERS) register.removeSingleMetric(name);
  });

  describe('switched off', () => {
    it('TC-144-09 the middleware only calls next, adds no listener and the service starts no timer', async () => {
      const { service, docs } = collect();
      const off = make(false, doc => docs.push(doc)).service;
      const res = { on: jest.fn() };
      const next = jest.fn();
      off.httpMiddleware()({} as never, res as never, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.on).not.toHaveBeenCalled();
      await off.start(T0);
      expect((off as unknown as { timer?: unknown }).timer).toBeUndefined();
      await off.flush(T0 + MINUTE);
      expect(docs).toEqual([]);
      expect(service).toBeDefined();
    });
  });

  describe('HTTP lines', () => {
    it('TC-144-04 flush writes a counter line and a latency line stamped with the start of the interval', async () => {
      const { service, docs } = collect();
      await service.start(T0);
      service.stats.record({
        route: '/v1/transfers',
        method: 'POST',
        status: 200,
        durationMs: 30,
        aborted: false,
      });
      service.stats.record({
        route: '/v1/transfers',
        method: 'POST',
        status: 500,
        durationMs: 400,
        aborted: false,
      });
      await service.flush(T0 + MINUTE);
      expect(docs.map(names)).toEqual([
        ['http_requests_total', 'http_5xx_total', 'http_aborted_total'],
        ['http_request_duration_ms'],
      ]);
      expect(docs[0]._aws.Timestamp).toBe(T0);
      expect(docs[0].http_requests_total).toBe(2);
      expect(docs[0].http_5xx_total).toBe(1);
      expect(docs[1].http_request_duration_ms).toEqual([50, 500]);
    });

    it('TC-144-11 the next interval starts where the last one ended', async () => {
      const { service, docs } = collect();
      await service.start(T0);
      await service.flush(T0 + MINUTE);
      service.stats.record({
        route: '/v1/x',
        method: 'GET',
        status: 200,
        durationMs: 1,
        aborted: false,
      });
      await service.flush(T0 + 2 * MINUTE + 800);
      expect(docs[0]._aws.Timestamp).toBe(T0 + MINUTE);
    });
  });

  describe('counters', () => {
    it('TC-144-06 writes the increase of every counter on the list, with its labels and the role', async () => {
      const redis = counter('redis_fallback_total');
      const limited = counter('rate_limited_total', ['scope']);
      const risk = counter('risk_redis_fallback_total', ['rule', 'reason']);
      const config = counter('risk_config_redis_fallback_total', ['reason']);
      const { service, docs } = collect();
      await service.start(T0);
      redis.inc(3);
      limited.inc({ scope: 'ip' }, 2);
      limited.inc({ scope: 'user' });
      risk.inc({ rule: 'R1', reason: 'error' }, 4);
      config.inc({ reason: 'corrupt' });
      await service.flush(T0 + MINUTE);

      const byName = new Map(docs.map(d => [names(d)[0], d]));
      expect(byName.get('redis_fallback_total')?.redis_fallback_total).toBe(3);
      expect(byName.get('redis_fallback_total')?.Role).toBe('api');
      expect(byName.get('risk_config_redis_fallback_total')?.risk_config_redis_fallback_total).toBe(
        1,
      );
      // BL-208: per reason for the dashboard, and the Role-only set an alarm can watch.
      expect(byName.get('risk_config_redis_fallback_total')).toMatchObject({ Reason: 'corrupt' });
      expect(
        byName.get('risk_config_redis_fallback_total')?._aws.CloudWatchMetrics[0].Dimensions,
      ).toEqual([['Role', 'Reason'], ['Role']]);
      const risks = docs.filter(d => names(d)[0] === 'risk_redis_fallback_total');
      expect(risks).toHaveLength(1);
      expect(risks[0]).toMatchObject({ Rule: 'R1', Reason: 'error', risk_redis_fallback_total: 4 });
      expect(risks[0]._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Role', 'Rule', 'Reason']]);
      const limits = docs.filter(d => names(d)[0] === 'rate_limited_total');
      expect(limits.map(d => [d.Scope, d.rate_limited_total]).sort()).toEqual([
        ['ip', 2],
        ['user', 1],
      ]);
    });

    it('TC-144-06 writes nothing for a counter that did not move, and only the increase the next time', async () => {
      const redis = counter('redis_fallback_total');
      const { service, docs } = collect();
      await service.start(T0);
      redis.inc(5);
      await service.flush(T0 + MINUTE);
      await service.flush(T0 + 2 * MINUTE);
      expect(docs).toHaveLength(1);
      redis.inc(2);
      await service.flush(T0 + 3 * MINUTE);
      expect(docs).toHaveLength(2);
      expect(docs[1].redis_fallback_total).toBe(2);
    });

    it('TC-144-06 ignores a counter that is not on the list', async () => {
      const other = counter('risk_unsupported_mode_total');
      const { service, docs } = collect();
      await service.start(T0);
      other.inc(9);
      await service.flush(T0 + MINUTE);
      expect(docs).toEqual([]);
    });

    it('TC-144-06 does not count what a counter held before the service started', async () => {
      const redis = counter('redis_fallback_total');
      redis.inc(40);
      const { service, docs } = collect();
      await service.start(T0);
      redis.inc(1);
      await service.flush(T0 + MINUTE);
      expect(docs).toHaveLength(1);
      expect(docs[0].redis_fallback_total).toBe(1);
    });

    it('TC-144-06 takes a counter that went down as a reset and counts again from there', async () => {
      const redis = counter('redis_fallback_total');
      const { service, docs } = collect();
      await service.start(T0);
      redis.inc(10);
      await service.flush(T0 + MINUTE);
      register.removeSingleMetric('redis_fallback_total');
      const again = counter('redis_fallback_total');
      again.inc(3);
      await service.flush(T0 + 2 * MINUTE);
      expect(docs).toHaveLength(1);
      again.inc(1);
      await service.flush(T0 + 3 * MINUTE);
      expect(docs[1].redis_fallback_total).toBe(1);
    });

    it('TC-144-06 a counter that appears after the start is counted from zero', async () => {
      const { service, docs } = collect();
      await service.start(T0);
      counter('redis_fallback_total').inc(2);
      await service.flush(T0 + MINUTE);
      expect(docs[0].redis_fallback_total).toBe(2);
    });
  });

  describe('risk and reconciliation counters (BL-204, BL-207, BL-046, BL-127)', () => {
    it('TC-204-01 risk_rule_error_total, risk_decision_total and reconciliation_runs_total are written with Role and their one dimension', async () => {
      const ruleErrors = counter('risk_rule_error_total', ['rule']);
      const decisions = counter('risk_decision_total', ['ai_status']);
      const runs = counter('reconciliation_runs_total', ['status']);
      const { service, docs } = collect();
      await service.start(T0);
      ruleErrors.inc({ rule: 'R3' }, 2);
      decisions.inc({ ai_status: 'DISABLED' }, 5);
      decisions.inc({ ai_status: 'CONFIG_INVALID' });
      runs.inc({ status: 'MISMATCH' });
      await service.flush(T0 + MINUTE);

      const line = (name: string) => docs.filter(d => names(d)[0] === name);
      const [rule] = line('risk_rule_error_total');
      expect(rule).toMatchObject({ Role: 'api', Rule: 'R3', risk_rule_error_total: 2 });
      expect(rule._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Role', 'Rule']]);
      expect(rule._aws.CloudWatchMetrics[0].Metrics).toEqual([
        { Name: 'risk_rule_error_total', Unit: 'Count' },
      ]);
      const byStatus = line('risk_decision_total').map(d => [d.AiStatus, d.risk_decision_total]);
      expect(byStatus.sort()).toEqual([
        ['CONFIG_INVALID', 1],
        ['DISABLED', 5],
      ]);
      expect(line('risk_decision_total')[0]._aws.CloudWatchMetrics[0].Dimensions).toEqual([
        ['Role', 'AiStatus'],
      ]);
      const [run] = line('reconciliation_runs_total');
      expect(run).toMatchObject({ Role: 'api', Status: 'MISMATCH', reconciliation_runs_total: 1 });
      expect(run._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Role', 'Status']]);
    });

    it('TC-204-02 a label value that looks like an id or an e-mail is redacted, never written as it is', async () => {
      const decisions = counter('risk_decision_total', ['ai_status']);
      const { service, docs } = collect();
      await service.start(T0);
      decisions.inc({ ai_status: '3f2b8c1e-9a4d-4e21-8c7a-1b2c3d4e5f60' });
      decisions.inc({ ai_status: 'an@example.com' });
      await service.flush(T0 + MINUTE);
      expect(docs.map(d => d.AiStatus)).toEqual(['redacted', 'redacted']);
      expect(JSON.stringify(docs)).not.toMatch(/3f2b8c1e|example\.com/);
    });
  });

  describe('consumer counter (BL-209)', () => {
    it('TC-209-01 consumer_message_total is written with Role, Consumer and Outcome', async () => {
      const messages = counter('consumer_message_total', ['consumer', 'outcome']);
      const { service, docs } = collect();
      await service.start(T0);
      messages.inc({ consumer: 'risk', outcome: 'retry' }, 3);
      messages.inc({ consumer: 'notification', outcome: 'dead_letter' });
      await service.flush(T0 + MINUTE);
      const rows = docs
        .filter(d => names(d)[0] === 'consumer_message_total')
        .map(d => [d.Consumer, d.Outcome, d.consumer_message_total]);
      expect(rows.sort()).toEqual([
        ['notification', 'dead_letter', 1],
        ['risk', 'retry', 3],
      ]);
      expect(
        docs.find(d => names(d)[0] === 'consumer_message_total')!._aws.CloudWatchMetrics[0]
          .Dimensions,
      ).toEqual([['Role', 'Consumer', 'Outcome']]);
    });
  });

  describe('distributions (BL-204)', () => {
    const samplesOf = (docs: EmfDocument[], name: string) => docs.filter(d => names(d)[0] === name);

    it('TC-204-03 recordDistribution writes the samples of a flush as Milliseconds under Role, and nothing else', async () => {
      const { service, docs } = collect();
      await service.start(T0);
      service.recordDistribution('risk_transfer_to_flag_ms', 120);
      service.recordDistribution('risk_transfer_to_flag_ms', 4800);
      service.recordDistribution('risk_ai_call_duration_ms', 900);
      await service.flush(T0 + MINUTE);

      const [flag] = samplesOf(docs, 'risk_transfer_to_flag_ms');
      expect(flag._aws.Timestamp).toBe(T0);
      expect(flag._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Role']]);
      expect(flag._aws.CloudWatchMetrics[0].Metrics).toEqual([
        { Name: 'risk_transfer_to_flag_ms', Unit: 'Milliseconds' },
      ]);
      expect(flag.Role).toBe('api');
      // Bucket upper bounds, ascending: 120 -> 150, 4800 -> 5000 (the SLO threshold is a bound).
      expect(flag.risk_transfer_to_flag_ms).toEqual([150, 5000]);
      const [ai] = samplesOf(docs, 'risk_ai_call_duration_ms');
      expect(ai.risk_ai_call_duration_ms).toEqual([1000]);
      expect(Object.keys(ai).sort()).toEqual(['Role', '_aws', 'risk_ai_call_duration_ms']);
    });

    it('TC-204-03 a flush with no sample writes no distribution line, and the samples are not written twice', async () => {
      const { service, docs } = collect();
      await service.start(T0);
      await service.flush(T0 + MINUTE);
      expect(docs).toEqual([]);
      service.recordDistribution('risk_transfer_to_flag_ms', 10);
      await service.flush(T0 + 2 * MINUTE);
      await service.flush(T0 + 3 * MINUTE);
      expect(samplesOf(docs, 'risk_transfer_to_flag_ms')).toHaveLength(1);
    });

    it('TC-204-03 more than 100 samples are cut into lines of at most 100 values', async () => {
      const { service, docs } = collect();
      await service.start(T0);
      // 250 samples in 3 different buckets so each value of a bucket is spelled out.
      for (let i = 0; i < 250; i++) {
        service.recordDistribution('risk_transfer_to_flag_ms', [10, 100, 1000][i % 3]);
      }
      await service.flush(T0 + MINUTE);
      const lines = samplesOf(docs, 'risk_transfer_to_flag_ms');
      expect(lines.length).toBeGreaterThanOrEqual(3);
      const all = lines.flatMap(d => d.risk_transfer_to_flag_ms as number[]);
      for (const line of lines) {
        expect((line.risk_transfer_to_flag_ms as number[]).length).toBeLessThanOrEqual(100);
      }
      expect(all).toHaveLength(250);
    });

    it('TC-204-03 a name that is not on the list and a bad value are ignored', async () => {
      const { service, docs } = collect();
      await service.start(T0);
      service.recordDistribution('anything_ms' as never, 5);
      service.recordDistribution('risk_transfer_to_flag_ms', Number.NaN);
      service.recordDistribution('risk_transfer_to_flag_ms', -1);
      await service.flush(T0 + MINUTE);
      expect(docs).toEqual([]);
    });

    it('TC-204-03 switched off, nothing is kept and nothing is written', async () => {
      const docs: EmfDocument[] = [];
      const off = make(false, doc => docs.push(doc)).service;
      off.recordDistribution('risk_transfer_to_flag_ms', 10);
      await off.flush(T0 + MINUTE);
      expect(docs).toEqual([]);
    });
  });

  describe('gauges', () => {
    it('TC-144-07 writes the value of a gauge with the unit it declared, and nothing when it has none', async () => {
      const { service, docs } = collect();
      await service.start(T0);
      service.registerGauge({
        name: 'outbox_oldest_unpublished_age_seconds',
        unit: 'Seconds',
        read: () => Promise.resolve(12.5),
      });
      service.registerGauge({
        name: 'nothing_here',
        unit: 'Count',
        read: () => Promise.resolve(null),
      });
      await service.flush(T0 + MINUTE);
      expect(docs).toHaveLength(1);
      expect(docs[0].outbox_oldest_unpublished_age_seconds).toBe(12.5);
      expect(docs[0]._aws.CloudWatchMetrics[0].Metrics[0].Unit).toBe('Seconds');
      expect(docs[0]._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
    });

    it('TC-144-10 a gauge that throws costs only its own line, and the warning holds no error text', async () => {
      const { service, docs } = collect();
      await service.start(T0);
      service.stats.record({
        route: '/v1/x',
        method: 'GET',
        status: 200,
        durationMs: 1,
        aborted: false,
      });
      service.registerGauge({
        name: 'broken',
        unit: 'Count',
        read: () => Promise.reject(new Error('connection to 10.0.0.5 password=hunter2 refused')),
      });
      service.registerGauge({ name: 'fine', unit: 'Count', read: () => Promise.resolve(1) });
      await service.flush(T0 + MINUTE);
      expect(docs.map(d => names(d)[0])).toEqual([
        'http_requests_total',
        'http_request_duration_ms',
        'fine',
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/hunter2|10\.0\.0\.5/);
    });

    it('TC-144-10 a gauge that never answers lets flush finish within 3 s, and is not read again while it hangs', async () => {
      jest.useFakeTimers({ now: T0 });
      const { service, docs } = collect();
      await service.start(T0);
      const read = jest.fn(() => new Promise<number>(() => undefined));
      service.registerGauge({ name: 'stuck', unit: 'Count', read });
      service.stats.record({
        route: '/v1/x',
        method: 'GET',
        status: 200,
        durationMs: 1,
        aborted: false,
      });

      let done = false;
      const first = service.flush(T0 + MINUTE).then(() => (done = true));
      await jest.advanceTimersByTimeAsync(2_999);
      expect(done).toBe(false);
      expect(docs.map(d => names(d)[0])).toContain('http_requests_total');
      await jest.advanceTimersByTimeAsync(2);
      await first;
      expect(done).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);

      service.stats.record({
        route: '/v1/x',
        method: 'GET',
        status: 200,
        durationMs: 1,
        aborted: false,
      });
      await service.flush(T0 + 2 * MINUTE);
      expect(read).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(docs.filter(d => names(d)[0] === 'http_requests_total')).toHaveLength(2);
    });

    it('TC-144-10 two flushes at once share one run', async () => {
      const { service, docs } = collect();
      await service.start(T0);
      let release: (v: number) => void = () => undefined;
      const read = jest.fn(() => new Promise<number>(resolve => (release = resolve)));
      service.registerGauge({ name: 'slow', unit: 'Count', read });
      const a = service.flush(T0 + MINUTE);
      const b = service.flush(T0 + MINUTE);
      while (read.mock.calls.length === 0) await new Promise(r => setImmediate(r));
      release(7);
      await Promise.all([a, b]);
      expect(read).toHaveBeenCalledTimes(1);
      expect(docs.filter(d => names(d)[0] === 'slow')).toHaveLength(1);
    });
  });

  describe('output', () => {
    it('TC-144-10 a sink that throws never makes flush throw', async () => {
      const service = make(true, () => {
        throw new Error('stdout closed');
      }).service;
      await service.start(T0);
      service.stats.record({
        route: '/v1/x',
        method: 'GET',
        status: 200,
        durationMs: 1,
        aborted: false,
      });
      await expect(service.flush(T0 + MINUTE)).resolves.toBeUndefined();
    });

    it('TC-144-10 a line CloudWatch would drop is not written, and says so without a value', async () => {
      const { service, docs } = collect();
      await service.start(T0);
      service.registerGauge({
        name: 'bad',
        unit: 'Count',
        read: () => Promise.resolve(Number.NaN),
      });
      await service.flush(T0 + MINUTE);
      expect(docs).toEqual([]);
      expect(warn).toHaveBeenCalled();
    });

    it('TC-144-08 without a sink it writes through the application logger at info level', async () => {
      const { service, docs, child } = make(true);
      await service.start(T0);
      service.stats.record({
        route: '/v1/x',
        method: 'GET',
        status: 200,
        durationMs: 1,
        aborted: false,
      });
      await service.flush(T0 + MINUTE);
      expect(child).toHaveBeenCalledWith({}, { level: 'info' });
      expect(docs.length).toBe(2);
    });
  });

  describe('lifecycle', () => {
    it('TC-144-11 start runs a timer that does not hold the process, and stop ends it', async () => {
      jest.useFakeTimers({ now: T0 });
      const { service } = collect();
      await service.start(T0);
      const timer = (service as unknown as { timer?: NodeJS.Timeout }).timer;
      expect(timer).toBeDefined();
      expect(timer?.hasRef()).toBe(false);
    });

    it('TC-144-11 shutdown writes what is left, without reading gauges, flushes the logger and stops', async () => {
      jest.useFakeTimers({ now: T0 + MINUTE });
      const { service, docs, flushLogger } = make(true);
      await service.start(T0);
      const read = jest.fn(() => Promise.resolve(1));
      service.registerGauge({ name: 'g', unit: 'Count', read });
      service.stats.record({
        route: '/v1/x',
        method: 'GET',
        status: 200,
        durationMs: 1,
        aborted: false,
      });
      await service.onApplicationShutdown();
      expect(docs.map(d => names(d)[0])).toEqual([
        'http_requests_total',
        'http_request_duration_ms',
      ]);
      expect(read).not.toHaveBeenCalled();
      expect(flushLogger).toHaveBeenCalledTimes(1);
      expect((service as unknown as { timer?: unknown }).timer).toBeUndefined();
    });

    it('TC-144-11 the timer flushes on its own', async () => {
      jest.useFakeTimers({ now: T0 });
      const { service, docs } = collect();
      await service.start(T0);
      service.stats.record({
        route: '/v1/x',
        method: 'GET',
        status: 200,
        durationMs: 1,
        aborted: false,
      });
      await jest.advanceTimersByTimeAsync(MINUTE);
      expect(docs.length).toBeGreaterThan(0);
      await service.onApplicationShutdown();
    });
  });

  describe('roles', () => {
    it('TC-144-06 a counter carries the role of the process', async () => {
      const docs: EmfDocument[] = [];
      const service = make(true, doc => docs.push(doc), 'worker').service;
      await service.start(T0);
      counter('redis_fallback_total').inc();
      await service.flush(T0 + MINUTE);
      expect(docs[0].Role).toBe('worker');
    });
  });
});
