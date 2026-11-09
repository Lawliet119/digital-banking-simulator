import {
  normalizeMethod,
  sanitizeDimensionValue,
  splitSamples,
  type EmfDimensionName,
  type EmfSpec,
} from './emf';
import { LatencyHistogram, type DrainedLatency } from './latency-histogram';

/** Distinct `(route, method)` pairs kept in one interval; the rest fold into `overflow`. */
export const MAX_HTTP_GROUPS = 500;
const UNMATCHED = 'unmatched';
const OVERFLOW = 'overflow';

/**
 * The route template Express matched (`/v1/accounts/:id`), never the URL: a URL holds ids. A
 * request that matched no route (a 404, an answer of the IP limit before routing, a CORS
 * preflight) is `unmatched`, so strange paths cannot make up labels.
 */
export function normalizeRoute(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) return UNMATCHED;
  return sanitizeDimensionValue(path);
}

export interface HttpObservation {
  route: unknown;
  method: string | undefined;
  /** Absent when the connection closed before an answer was written. */
  status: number | undefined;
  durationMs: number;
  aborted: boolean;
}

export interface HttpGroup {
  route: string;
  method: string;
  requests: number;
  errors5xx: number;
  aborted: number;
  latency: DrainedLatency;
}

interface Accumulator {
  route: string;
  method: string;
  requests: number;
  errors5xx: number;
  aborted: number;
  histogram: LatencyHistogram;
}

/**
 * What the HTTP middleware saw since the last flush. An error is a 5xx: 422 and 429 are answers
 * the system gave on purpose (docs/03 §14). A request cut off before its answer counts on its own
 * and still enters the histogram, because the slowest requests are the ones clients give up on.
 */
export class HttpStats {
  private groups = new Map<string, Accumulator>();

  record(observation: HttpObservation): void {
    const route = normalizeRoute(observation.route);
    const method = normalizeMethod(observation.method);
    const acc = this.groupFor(route, method);
    acc.requests += 1;
    if (observation.aborted) acc.aborted += 1;
    else if (observation.status !== undefined && observation.status >= 500) acc.errors5xx += 1;
    acc.histogram.record(observation.durationMs);
  }

  drain(): HttpGroup[] {
    const groups = [...this.groups.values()].map(acc => ({
      route: acc.route,
      method: acc.method,
      requests: acc.requests,
      errors5xx: acc.errors5xx,
      aborted: acc.aborted,
      latency: acc.histogram.drain(),
    }));
    this.groups = new Map();
    return groups;
  }

  private groupFor(route: string, method: string): Accumulator {
    let key = `${method} ${route}`;
    let acc = this.groups.get(key);
    if (acc) return acc;
    if (this.groups.size >= MAX_HTTP_GROUPS) {
      route = OVERFLOW;
      key = `${method} ${route}`;
      acc = this.groups.get(key);
      if (acc) return acc;
    }
    acc = {
      route,
      method,
      requests: 0,
      errors5xx: 0,
      aborted: 0,
      histogram: new LatencyHistogram(),
    };
    this.groups.set(key, acc);
    return acc;
  }
}

const PER_ROUTE: EmfDimensionName[][] = [['Route', 'Method']];
/** Per route, per method and for the whole service: one metric for each (docs/03 §14 SLO table). */
const ROLLUPS: EmfDimensionName[][] = [['Route', 'Method'], ['Method'], []];

/**
 * The EMF lines for one group: one with the counters and as many with the latency samples as it
 * takes at 100 per line. The probes of the load balancer (`/health/*`) report per route only, so
 * they do not dilute the service-wide error rate.
 */
export function toEmfSpecs(group: HttpGroup, timestamp: number): EmfSpec[] {
  const dimensions = { Route: group.route, Method: group.method };
  const dimensionSets = group.route.startsWith('/health/') ? PER_ROUTE : ROLLUPS;
  const specs: EmfSpec[] = [
    {
      timestamp,
      dimensions,
      dimensionSets,
      metrics: [
        { name: 'http_requests_total', unit: 'Count', value: group.requests },
        { name: 'http_5xx_total', unit: 'Count', value: group.errors5xx },
        { name: 'http_aborted_total', unit: 'Count', value: group.aborted },
      ],
    },
  ];
  for (const piece of splitSamples(group.latency.samples)) {
    specs.push({
      timestamp,
      dimensions,
      dimensionSets,
      metrics: [{ name: 'http_request_duration_ms', unit: 'Milliseconds', value: piece }],
    });
  }
  return specs;
}
