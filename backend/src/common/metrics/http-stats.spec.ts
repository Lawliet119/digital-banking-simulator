import { buildEmf } from './emf';
import { HttpStats, MAX_HTTP_GROUPS, normalizeRoute, toEmfSpecs } from './http-stats';

const NOW = Date.UTC(2026, 10, 9, 11, 1, 0);

function record(
  stats: HttpStats,
  route: string | undefined,
  method: string,
  status: number | undefined,
  durationMs = 10,
  aborted = false,
): void {
  stats.record({ route, method, status, durationMs, aborted });
}

function group(stats: HttpStats, route: string, method: string) {
  const found = stats.drain().find(g => g.route === route && g.method === method);
  if (!found) throw new Error(`no group ${method} ${route}`);
  return found;
}

describe('HttpStats', () => {
  it('TC-144-04 counts 500 and 503 as errors, but not 200, 404, 422, 429 or 401', () => {
    const stats = new HttpStats();
    for (const status of [200, 404, 422, 429, 401, 500, 503]) {
      record(stats, '/v1/transfers', 'POST', status);
    }
    const g = group(stats, '/v1/transfers', 'POST');
    expect(g.requests).toBe(7);
    expect(g.errors5xx).toBe(2);
    expect(g.aborted).toBe(0);
  });

  it('TC-144-04 labels a request with no route as unmatched, whatever its path', () => {
    expect(normalizeRoute(undefined)).toBe('unmatched');
    expect(normalizeRoute('')).toBe('unmatched');
    expect(normalizeRoute(/regex/)).toBe('unmatched');
    expect(normalizeRoute('/v1/accounts/:id')).toBe('/v1/accounts/:id');
  });

  it('TC-144-04 groups by route template and method; HEAD stays HEAD; a strange method is OTHER', () => {
    const stats = new HttpStats();
    record(stats, '/v1/accounts/:id', 'GET', 200);
    record(stats, '/v1/accounts/:id', 'GET', 200);
    record(stats, '/v1/accounts/:id', 'head', 200);
    record(stats, undefined, 'OPTIONS', 204);
    record(stats, undefined, 'PROPFIND', 404);
    const keys = stats
      .drain()
      .map(g => `${g.method} ${g.route}:${g.requests}`)
      .sort();
    expect(keys).toEqual([
      'GET /v1/accounts/:id:2',
      'HEAD /v1/accounts/:id:1',
      'OPTIONS unmatched:1',
      'OTHER unmatched:1',
    ]);
  });

  it('TC-144-04 an aborted request is counted and timed, and is not a 5xx', () => {
    const stats = new HttpStats();
    record(stats, '/v1/transfers', 'POST', undefined, 900, true);
    const g = group(stats, '/v1/transfers', 'POST');
    expect(g.requests).toBe(1);
    expect(g.aborted).toBe(1);
    expect(g.errors5xx).toBe(0);
    expect(g.latency.samples).toEqual([1000]);
  });

  it('TC-144-04 is empty after a drain', () => {
    const stats = new HttpStats();
    record(stats, '/v1/transfers', 'POST', 200);
    stats.drain();
    expect(stats.drain()).toEqual([]);
  });

  it('TC-144-04 folds groups past the cap into one overflow group, so the label set cannot grow without bound', () => {
    const stats = new HttpStats();
    for (let i = 0; i < MAX_HTTP_GROUPS + 20; i++) record(stats, `/r${i}`, 'GET', 200);
    const groups = stats.drain();
    expect(groups.length).toBeLessThanOrEqual(MAX_HTTP_GROUPS + 1);
    expect(groups.find(g => g.route === 'overflow')?.requests).toBe(20);
  });
});

describe('toEmfSpecs', () => {
  function specsFor(route: string, durations: number[]) {
    const stats = new HttpStats();
    for (const d of durations) record(stats, route, 'POST', 200, d);
    record(stats, route, 'POST', 500, 5);
    return toEmfSpecs(stats.drain()[0], NOW - 60_000);
  }

  it('TC-144-04 gives one counter line and one latency line for a small group', () => {
    const specs = specsFor('/v1/transfers', [20, 20, 50]);
    expect(specs).toHaveLength(2);
    const counters = specs.find(s => s.metrics.some(m => m.name === 'http_requests_total'));
    expect(counters?.metrics.map(m => [m.name, m.value])).toEqual([
      ['http_requests_total', 4],
      ['http_5xx_total', 1],
      ['http_aborted_total', 0],
    ]);
    const latency = specs.find(s => s.metrics.some(m => m.name === 'http_request_duration_ms'));
    expect(latency?.metrics).toEqual([
      { name: 'http_request_duration_ms', unit: 'Milliseconds', value: [5, 20, 20, 50] },
    ]);
  });

  it('TC-144-04 cuts the latency into lines of at most 100 samples and keeps every one', () => {
    const specs = specsFor(
      '/v1/transfers',
      Array.from({ length: 250 }, () => 20),
    );
    const lines = specs.filter(s => s.metrics[0].name === 'http_request_duration_ms');
    expect(lines.map(l => (l.metrics[0].value as number[]).length)).toEqual([100, 100, 51]);
    for (const spec of specs) expect(() => buildEmf(spec, NOW)).not.toThrow();
  });

  it('TC-144-04 health routes only report per route, so probes do not dilute the service-wide rate', () => {
    for (const spec of specsFor('/health/live', [3])) {
      expect(spec.dimensionSets).toEqual([['Route', 'Method']]);
    }
    for (const spec of specsFor('/v1/transfers', [3])) {
      expect(spec.dimensionSets).toEqual([['Route', 'Method'], ['Method'], []]);
    }
  });
});
