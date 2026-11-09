/**
 * CloudWatch Embedded Metric Format (DBS-144, docs/03 §14, docs/components/observability).
 *
 * A line of JSON with an `_aws` object is turned into CloudWatch metrics by the `awslogs` driver,
 * with no agent, no IAM permission and no open port. The rules below are the ones of the AWS
 * specification ("Specification: Embedded metric format"): a metric target is a number or an array
 * of at most 100 numbers and is never a nested object; at most 100 metrics per line; a timestamp
 * no more than 14 days old and no more than 2 hours ahead; every dimension set creates a new
 * metric. A line that breaks a rule is dropped by CloudWatch without any message, so `buildEmf`
 * throws instead of writing it.
 */

export const EMF_NAMESPACE = 'DBS/Backend';

/** The only dimension names a metric may carry: none of them can hold an id of a person. */
export const EMF_DIMENSION_NAMES = ['Route', 'Method', 'Role', 'Rule', 'Reason', 'Scope'] as const;
export type EmfDimensionName = (typeof EMF_DIMENSION_NAMES)[number];

export type EmfUnit = 'Milliseconds' | 'Seconds' | 'Count';

export interface EmfMetricSpec {
  name: string;
  unit: EmfUnit;
  /** A number, or an array of 1 to 100 numbers (one per sample). */
  value: number | number[];
}

export interface EmfSpec {
  /** Milliseconds since the epoch: the start of the interval the numbers describe. */
  timestamp: number;
  dimensions: Partial<Record<EmfDimensionName, string>>;
  /** Each set is a list of names from `dimensions`; `[]` is the set with no dimension. */
  dimensionSets: EmfDimensionName[][];
  metrics: EmfMetricSpec[];
}

export interface EmfDocument {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: {
      Namespace: string;
      Dimensions: EmfDimensionName[][];
      Metrics: { Name: string; Unit: EmfUnit }[];
    }[];
  };
  [member: string]: unknown;
}

export const EMF_MAX_VALUES = 100;
export const EMF_MAX_METRICS = 100;
const MAX_AGE_MS = 14 * 24 * 3_600_000;
const MAX_AHEAD_MS = 2 * 3_600_000;
const MAX_DIMENSION_LENGTH = 200;
const METRIC_NAME = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL = /\S+@\S+/;
const LONG_NUMBER = /\d{6,}/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * A dimension value is a label, never data about a person: a value that looks like a UUID, an
 * e-mail address or a long number (an account number, a phone number) is replaced, and so is
 * anything that is not printable ASCII (CloudWatch rejects it).
 */
export function sanitizeDimensionValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'none';
  if (
    !PRINTABLE_ASCII.test(trimmed) ||
    UUID.test(trimmed) ||
    EMAIL.test(trimmed) ||
    LONG_NUMBER.test(trimmed)
  ) {
    return 'redacted';
  }
  return trimmed.slice(0, MAX_DIMENSION_LENGTH);
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** A fixed set, so a client cannot make up new label values with an odd HTTP method. */
export function normalizeMethod(method: string | undefined): string {
  const upper = (method ?? '').toUpperCase();
  return METHODS.has(upper) ? upper : 'OTHER';
}

/** Cuts samples into pieces of at most 100: one EMF line per piece. */
export function splitSamples(samples: number[], size = EMF_MAX_VALUES): number[][] {
  const pieces: number[][] = [];
  for (let i = 0; i < samples.length; i += size) pieces.push(samples.slice(i, i + size));
  return pieces;
}

function assertNumber(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`EMF metric ${name} holds a value that is not a finite number`);
  }
}

export function buildEmf(spec: EmfSpec, now: number = Date.now()): EmfDocument {
  if (spec.timestamp < now - MAX_AGE_MS || spec.timestamp > now + MAX_AHEAD_MS) {
    throw new Error('EMF timestamp is more than 14 days old or 2 hours ahead');
  }
  if (spec.metrics.length === 0 || spec.metrics.length > EMF_MAX_METRICS) {
    throw new Error(`EMF line must hold 1 to ${EMF_MAX_METRICS} metrics`);
  }

  const allowed: readonly string[] = EMF_DIMENSION_NAMES;
  const dimensions: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.dimensions)) {
    if (!allowed.includes(name)) throw new Error(`EMF dimension ${name} is not allowed`);
    dimensions[name] = sanitizeDimensionValue(value);
  }
  for (const set of spec.dimensionSets) {
    for (const name of set) {
      if (!(name in dimensions))
        throw new Error(`EMF dimension set names ${name}, which is absent`);
    }
  }

  const doc: EmfDocument = {
    _aws: {
      Timestamp: spec.timestamp,
      CloudWatchMetrics: [
        {
          Namespace: EMF_NAMESPACE,
          Dimensions: spec.dimensionSets.map(set => [...set]),
          Metrics: spec.metrics.map(m => ({ Name: m.name, Unit: m.unit })),
        },
      ],
    },
    ...dimensions,
  };

  const seen = new Set<string>();
  for (const metric of spec.metrics) {
    if (!METRIC_NAME.test(metric.name))
      throw new Error(`EMF metric name ${metric.name} is invalid`);
    if (seen.has(metric.name) || metric.name in dimensions) {
      throw new Error(`EMF metric name ${metric.name} is used twice`);
    }
    seen.add(metric.name);
    if (Array.isArray(metric.value)) {
      if (metric.value.length < 1 || metric.value.length > EMF_MAX_VALUES) {
        throw new Error(`EMF metric ${metric.name} must hold 1 to ${EMF_MAX_VALUES} values`);
      }
      for (const v of metric.value) assertNumber(metric.name, v);
    } else {
      assertNumber(metric.name, metric.value);
    }
    doc[metric.name] = metric.value;
  }
  return doc;
}
