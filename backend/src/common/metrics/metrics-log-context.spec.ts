import { Writable } from 'node:stream';
import { PinoLogger } from 'nestjs-pino';
import { Counter, register } from 'prom-client';
import { createLoggingOptions } from '../logging/logging.options';
import { runInLogContext } from '../logging/log-context';
import { MetricsService } from './metrics.service';

const T0 = Date.UTC(2026, 10, 14, 9, 0, 0);
const MINUTE = 60_000;
const A = '34b4c724-48ad-4e8c-98ce-e16a5c03b007';

/**
 * BL-024: the metrics flush is process-level work, so its lines say `role=worker` even in a `both`
 * process, whoever triggered the flush (the timer, the shutdown hook, or a request's context).
 */
describe('MetricsService log context (BL-024)', () => {
  let output = '';
  let service: MetricsService;
  let redis: Counter;

  const lines = () =>
    output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
  const metricLines = () => lines().filter(line => 'redis_fallback_total' in line);

  beforeEach(async () => {
    output = '';
    register.removeSingleMetric('redis_fallback_total');
    redis = new Counter({ name: 'redis_fallback_total', help: 'x', registers: [register] });
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString();
        done();
      },
    });
    // APP_ROLE=both: outside a context the default role of a line is `api`.
    new PinoLogger({
      pinoHttp: [createLoggingOptions({ role: 'both', logLevel: 'verbose' }), stream],
    });
    service = new MetricsService({ enabled: true, flushMs: MINUTE }, { role: 'both' } as never);
    await service.start(T0);
  });
  afterEach(() => {
    register.removeSingleMetric('redis_fallback_total');
  });

  it('writes the EMF line with role=worker and no correlationId in a both process', async () => {
    redis.inc(2);
    await service.flush(T0 + MINUTE);
    expect(metricLines()).toHaveLength(1);
    expect(metricLines()[0]).toMatchObject({
      appRole: 'both',
      role: 'worker',
      correlationId: null,
      redis_fallback_total: 2,
    });
  });

  it('does not take the role or the id of the request that happened to trigger the flush', async () => {
    redis.inc();
    await runInLogContext(() => service.flush(T0 + MINUTE), { role: 'api', correlationId: A });
    expect(metricLines()[0]).toMatchObject({ role: 'worker', correlationId: null });
    // The child logger is cached for later flushes: it must not remember that request either.
    redis.inc();
    await service.flush(T0 + 2 * MINUTE);
    expect(metricLines()[1]).toMatchObject({ role: 'worker', correlationId: null });
  });
});
