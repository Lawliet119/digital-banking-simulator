import { Writable } from 'node:stream';
import pino from 'pino';
import { createLoggingOptions } from '../logging/logging.options';
import { buildEmf } from './emf';

/**
 * TC-144-01b: EMF lines go out through the application's own pino instance. Its redaction and
 * sanitising must leave `_aws` and every metric byte for byte as they were built, or CloudWatch
 * gets a line without its metrics and says nothing.
 */
describe('EMF through the application logger', () => {
  function logThroughPino(doc: object): Record<string, unknown> {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pino(createLoggingOptions({ role: 'api', logLevel: 'log' }), stream);
    logger.info(doc);
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]) as Record<string, unknown>;
  }

  it('TC-144-01b keeps _aws and every metric identical', () => {
    const now = Date.now();
    const latency = Array.from({ length: 100 }, (_, i) => [20, 50, 100, 300, 1000][i % 5]);
    for (const spec of [
      {
        timestamp: now - 60_000,
        dimensions: { Route: '/v1/transfers', Method: 'POST' },
        dimensionSets: [['Route', 'Method'], ['Method'], []] as ('Route' | 'Method')[][],
        metrics: [
          { name: 'http_requests_total', unit: 'Count' as const, value: 10 },
          { name: 'http_5xx_total', unit: 'Count' as const, value: 1 },
          { name: 'http_aborted_total', unit: 'Count' as const, value: 0 },
        ],
      },
      {
        timestamp: now - 60_000,
        dimensions: { Route: '/v1/accounts/:id', Method: 'GET' },
        dimensionSets: [['Route', 'Method']] as ('Route' | 'Method')[][],
        metrics: [
          { name: 'http_request_duration_ms', unit: 'Milliseconds' as const, value: latency },
        ],
      },
      {
        timestamp: now - 60_000,
        dimensions: { Role: 'worker', Rule: 'R1', Reason: 'error', Scope: 'ip' },
        dimensionSets: [
          ['Role', 'Rule', 'Reason'],
          ['Role', 'Scope'],
        ] as ('Role' | 'Rule' | 'Reason' | 'Scope')[][],
        metrics: [
          { name: 'risk_redis_fallback_total', unit: 'Count' as const, value: 3 },
          { name: 'rate_limited_total', unit: 'Count' as const, value: 2 },
          { name: 'outbox_oldest_unpublished_age_seconds', unit: 'Seconds' as const, value: 42.5 },
        ],
      },
    ]) {
      const doc = buildEmf(spec, now);
      const out = logThroughPino(doc);
      expect(out._aws).toEqual(doc._aws);
      for (const { name } of spec.metrics) expect(out[name]).toEqual(doc[name]);
      for (const name of Object.keys(spec.dimensions)) expect(out[name]).toEqual(doc[name]);
    }
  });
});
