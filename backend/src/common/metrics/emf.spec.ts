import {
  buildEmf,
  EMF_NAMESPACE,
  normalizeMethod,
  sanitizeDimensionValue,
  splitSamples,
  type EmfSpec,
} from './emf';

const NOW = Date.UTC(2026, 10, 9, 11, 1, 0);

function spec(over: Partial<EmfSpec> = {}): EmfSpec {
  return {
    timestamp: NOW - 60_000,
    dimensions: { Route: '/v1/operator/deposits', Method: 'POST' },
    dimensionSets: [['Route', 'Method'], ['Method'], []],
    metrics: [
      { name: 'http_requests_total', unit: 'Count', value: 10 },
      { name: 'http_5xx_total', unit: 'Count', value: 0 },
    ],
    ...over,
  };
}

describe('buildEmf', () => {
  it('TC-144-01 writes the structure CloudWatch extracts metrics from', () => {
    const doc = buildEmf(spec(), NOW);
    expect(doc._aws.Timestamp).toBe(NOW - 60_000);
    expect(doc._aws.CloudWatchMetrics).toEqual([
      {
        Namespace: EMF_NAMESPACE,
        Dimensions: [['Route', 'Method'], ['Method'], []],
        Metrics: [
          { Name: 'http_requests_total', Unit: 'Count' },
          { Name: 'http_5xx_total', Unit: 'Count' },
        ],
      },
    ]);
    expect(doc.Route).toBe('/v1/operator/deposits');
    expect(doc.Method).toBe('POST');
    expect(doc.http_requests_total).toBe(10);
    expect(doc.http_5xx_total).toBe(0);
  });

  it('TC-144-01 every metric target is a number or a number array of at most 100, never an object', () => {
    const doc = buildEmf(
      spec({
        metrics: [
          { name: 'http_request_duration_ms', unit: 'Milliseconds', value: [20, 20, 50, 100] },
          { name: 'http_requests_total', unit: 'Count', value: 4 },
        ],
      }),
      NOW,
    );
    for (const { Name } of doc._aws.CloudWatchMetrics[0].Metrics) {
      const value = doc[Name];
      const ok =
        typeof value === 'number' ||
        (Array.isArray(value) &&
          value.length >= 1 &&
          value.length <= 100 &&
          value.every(v => typeof v === 'number'));
      expect(ok).toBe(true);
    }
  });

  it('TC-144-01 refuses a value that CloudWatch would drop or that would drop the whole line', () => {
    const one = (value: number | number[]) =>
      spec({ metrics: [{ name: 'm', unit: 'Count', value }] });
    expect(() => buildEmf(one(Number.NaN), NOW)).toThrow();
    expect(() => buildEmf(one(Number.POSITIVE_INFINITY), NOW)).toThrow();
    expect(() => buildEmf(one([]), NOW)).toThrow();
    expect(() => buildEmf(one(Array.from({ length: 101 }, () => 1)), NOW)).toThrow();
    expect(() => buildEmf(one(Array.from({ length: 100 }, () => 1)), NOW)).not.toThrow();
  });

  it('TC-144-01 refuses a timestamp more than 14 days old or 2 hours ahead', () => {
    expect(() => buildEmf(spec({ timestamp: NOW - 14 * 86_400_000 - 1 }), NOW)).toThrow();
    expect(() => buildEmf(spec({ timestamp: NOW + 2 * 3_600_000 + 1 }), NOW)).toThrow();
    expect(() => buildEmf(spec({ timestamp: NOW - 14 * 86_400_000 }), NOW)).not.toThrow();
  });

  it('TC-144-01 refuses more than 100 metrics, a bad metric name and duplicate names', () => {
    const many = Array.from({ length: 101 }, (_, i) => ({
      name: `m_${i}`,
      unit: 'Count' as const,
      value: 1,
    }));
    expect(() => buildEmf(spec({ metrics: many }), NOW)).toThrow();
    expect(() =>
      buildEmf(spec({ metrics: [{ name: 'bad name!', unit: 'Count', value: 1 }] }), NOW),
    ).toThrow();
    expect(() =>
      buildEmf(
        spec({
          metrics: [
            { name: 'm', unit: 'Count', value: 1 },
            { name: 'm', unit: 'Count', value: 2 },
          ],
        }),
        NOW,
      ),
    ).toThrow();
  });

  it('TC-144-02 refuses a dimension name outside the allowlist and a set naming an absent dimension', () => {
    expect(() =>
      buildEmf(
        spec({ dimensions: { Route: '/x', UserId: 'abc' } as unknown as EmfSpec['dimensions'] }),
        NOW,
      ),
    ).toThrow(/UserId/);
    expect(() => buildEmf(spec({ dimensionSets: [['Role']] }), NOW)).toThrow(/Role/);
  });

  it('TC-144-02 replaces a dimension value that looks like an id, an email or a long number', () => {
    const doc = buildEmf(
      spec({
        dimensions: { Route: '/v1/accounts/3f2b8c1e-9a4d-4e21-8c7a-1b2c3d4e5f60', Method: 'GET' },
      }),
      NOW,
    );
    expect(doc.Route).toBe('redacted');
    expect(JSON.stringify(doc)).not.toMatch(/3f2b8c1e/);
  });
});

describe('sanitizeDimensionValue', () => {
  it.each([
    ['/v1/accounts/:id', '/v1/accounts/:id'],
    ['/v1/transfers', '/v1/transfers'],
    ['3f2b8c1e-9a4d-4e21-8c7a-1b2c3d4e5f60', 'redacted'],
    ['/v1/x/3F2B8C1E-9A4D-4E21-8C7A-1B2C3D4E5F60/y', 'redacted'],
    ['someone@example.com', 'redacted'],
    ['/v1/accounts/1234567', 'redacted'],
    ['/v1/accounts/12345', '/v1/accounts/12345'],
    ['tên-tiếng-việt', 'redacted'],
    ['', 'none'],
    ['   ', 'none'],
  ])('TC-144-02 %j -> %j', (input, expected) => {
    expect(sanitizeDimensionValue(input)).toBe(expected);
  });

  it('TC-144-02 cuts a value to 200 characters', () => {
    expect(sanitizeDimensionValue('a'.repeat(500))).toHaveLength(200);
  });
});

describe('normalizeMethod', () => {
  it.each([
    ['GET', 'GET'],
    ['post', 'POST'],
    ['HEAD', 'HEAD'],
    ['OPTIONS', 'OPTIONS'],
    ['PROPFIND', 'OTHER'],
    ['', 'OTHER'],
    [undefined, 'OTHER'],
  ])('TC-144-02 %j -> %j', (input, expected) => {
    expect(normalizeMethod(input)).toBe(expected);
  });
});

describe('splitSamples', () => {
  it('TC-144-01 cuts a sample list into lines of at most 100 and keeps every sample', () => {
    const samples = Array.from({ length: 250 }, (_, i) => i + 1);
    const lines = splitSamples(samples);
    expect(lines.map(l => l.length)).toEqual([100, 100, 50]);
    expect(lines.flat()).toEqual(samples);
  });
  it('TC-144-01 gives no line for no sample', () => {
    expect(splitSamples([])).toEqual([]);
  });
});
