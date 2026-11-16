import type { AiAssessment } from '../ai/ai-contract';
import { captureAi, parseCaptureLines, selectSample, type CaptureLine } from './capture-ai';

const HEADER =
  'tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario';
const row = (n: number, fraud: 0 | 1, scenario: string): string =>
  [
    `t${n}`,
    `2026-10-01T10:${String(n % 60).padStart(2, '0')}:00.000Z`,
    `from-${n}`,
    `to-${n}`,
    `cust-${n}`,
    `cust-to-${n}`,
    '500000',
    '1000000000',
    '2024-01-01T00:00:00.000Z',
    '2024-01-01T00:00:00.000Z',
    String(fraud),
    scenario,
  ].join(',');

// 2 fraud + 1 hard negative + 20 NORMAL
const CSV = [
  HEADER,
  row(1, 1, 'ATO_DRAIN'),
  row(2, 1, 'SLOW_DRIP'),
  row(3, 0, 'HN_RENT'),
  ...Array.from({ length: 20 }, (_, i) => row(10 + i, 0, 'NORMAL')),
].join('\n');

const answer = (status: AiAssessment['status'], probability: number | null): AiAssessment => ({
  status,
  probability,
  provider: 'openai',
  requestedModel: 'm',
  responseModel: 'm-1',
  requestId: null,
  rubricSha256: 'r',
  inputSha256: null,
  usage: { inputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0 },
});

const baseOptions = {
  csvText: CSV,
  seed: 's',
  normalSample: 5,
  model: 'm',
  rubric: 'rubric',
  apiKey: 'sk-test-secret',
  requestTimeoutMs: 1000,
  concurrency: 3,
  maxCalls: 1000,
  done: new Set<string>(),
};

describe('selectSample (DBS-212)', () => {
  it('TC-212-01 keeps every fraud and hard-negative row and a seeded subset of NORMAL, with weights', () => {
    const sample = selectSample(CSV, 's', 5);
    expect(sample.txIds).toHaveLength(2 + 1 + 5);
    expect(sample.txIds).toEqual(expect.arrayContaining(['t1', 't2', 't3']));
    expect(sample.weights.get('t1')).toBe(1);
    expect(sample.weights.get('t3')).toBe(1);
    const normal = sample.txIds.filter(id => !['t1', 't2', 't3'].includes(id));
    // 20 NORMAL rows stand behind 5 sampled ones.
    for (const id of normal) expect(sample.weights.get(id)).toBe(4);
    // Same seed, same sample; another seed picks another subset.
    expect(selectSample(CSV, 's', 5).txIds).toEqual(sample.txIds);
    expect(selectSample(CSV, 'other', 5).txIds).not.toEqual(sample.txIds);
    // The weights rebuild the file: 2 fraud + 1 hard negative + 20 NORMAL.
    const total = sample.txIds.reduce((sum, id) => sum + sample.weights.get(id)!, 0);
    expect(total).toBe(23);
  });

  it('TC-212-02 asks for at least one NORMAL row', () => {
    expect(() => selectSample(CSV, 's', 0)).toThrow(/positive integer/);
  });
});

describe('captureAi (DBS-212)', () => {
  it('TC-212-03 calls the API once per sampled transfer with the 11 features and never leaks the key', async () => {
    const inputs: unknown[] = [];
    const lines: CaptureLine[] = [];
    const summary = await captureAi({
      ...baseOptions,
      assess: (features, options) => {
        inputs.push(features);
        expect(options.apiKey).toBe('sk-test-secret');
        return Promise.resolve(answer('SUCCEEDED', 0.4));
      },
      onLine: line => lines.push(line),
    });
    expect(summary).toMatchObject({
      planned: 8,
      skipped: 0,
      captured: 8,
      calls: 8,
      stoppedEarly: null,
    });
    expect(Object.keys(inputs[0] as object).sort()).toEqual(
      [
        'accountAgeHours',
        'amount',
        'distinctRecipients24h',
        'fromBalanceBefore',
        'historyCount30d',
        'medianAmount30d',
        'minutesSinceReverse',
        'newRecipients1h',
        'sameOwner',
        'txCount10m',
        'txCount1h',
      ].sort(),
    );
    expect(JSON.stringify(lines)).not.toContain('sk-test-secret');
    expect(lines.every(line => line.attempts === 1 && line.assessment.status === 'SUCCEEDED')).toBe(
      true,
    );
  });

  it('TC-212-04 retries an unavailable answer twice, counts every attempt, then records the final answer', async () => {
    const lines: CaptureLine[] = [];
    const summary = await captureAi({
      ...baseOptions,
      limit: 1,
      assess: () => Promise.resolve(answer('UNAVAILABLE', null)),
      onLine: line => lines.push(line),
    });
    expect(summary.calls).toBe(3);
    expect(lines[0].attempts).toBe(3);
    expect(lines[0].assessment.status).toBe('UNAVAILABLE');
  });

  it('TC-212-05 stops at the call cap and skips transfers that are already captured', async () => {
    const calls: string[] = [];
    const capped = await captureAi({
      ...baseOptions,
      maxCalls: 3,
      concurrency: 1,
      assess: () => {
        calls.push('x');
        return Promise.resolve(answer('SUCCEEDED', 0.1));
      },
      onLine: () => undefined,
    });
    expect(capped.calls).toBe(3);
    expect(capped.stoppedEarly).toMatch(/call cap 3 reached/);

    const resumed = await captureAi({
      ...baseOptions,
      done: new Set(['t1', 't2', 't3']),
      assess: () => Promise.resolve(answer('SUCCEEDED', 0.1)),
      onLine: () => undefined,
    });
    expect(resumed).toMatchObject({ planned: 8, skipped: 3, captured: 5 });
  });

  it('TC-212-06 stops early when the first ten answers all fail (bad key or model)', async () => {
    const csv = [HEADER, ...Array.from({ length: 30 }, (_, i) => row(i + 1, 1, 'ATO_DRAIN'))].join(
      '\n',
    );
    const summary = await captureAi({
      ...baseOptions,
      csvText: csv,
      concurrency: 1,
      assess: () => Promise.resolve(answer('REFUSED', null)),
      onLine: () => undefined,
    });
    expect(summary.stoppedEarly).toMatch(/first 10 answers all failed/);
    expect(summary.captured).toBe(10);
  });
});

describe('parseCaptureLines (DBS-212)', () => {
  it('TC-212-07 reads weights, attempts and latency, with defaults for a plain capture line', () => {
    const full = JSON.stringify({
      txId: 'a',
      sampleWeight: 4,
      attempts: 2,
      latencyMs: 90,
      assessment: answer('SUCCEEDED', 0.5),
    });
    const plain = JSON.stringify({ txId: 'b', assessment: answer('SUCCEEDED', 0.5) });
    const lines = parseCaptureLines(`${full}\n${plain}\n`);
    expect(lines.get('a')).toMatchObject({ sampleWeight: 4, attempts: 2, latencyMs: 90 });
    expect(lines.get('b')).toMatchObject({ sampleWeight: 1, attempts: 1, latencyMs: 0 });
    const bad = JSON.stringify({
      txId: 'c',
      sampleWeight: 0,
      assessment: answer('SUCCEEDED', 0.5),
    });
    expect(() => parseCaptureLines(bad)).toThrow(/sampleWeight/);
  });
});
