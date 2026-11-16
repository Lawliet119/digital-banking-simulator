import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AiAssessment, DecisionOptions } from '../ai/ai-contract';
import { parseTransactionCsv } from '../features/export-features';
import { OfflineFeatureProvider } from '../features/offline-feature-provider';
import { parseCapture } from './evaluate-rules';

/**
 * One-time capture of the external AI answers for the ADR-14 gate (DBS-212). The answers are saved
 * and shared by B1 and B2, so the API is never called twice for the same transfer when a mode is
 * compared (`evaluate-rules` and `compare-modes` only read the capture).
 *
 * Only the 11 allowlisted numeric features of synthetic data leave the machine (RSK-05).
 */

const OFFLINE_PER_TX_LIMIT = 500_000_000n;

export type AssessFn = (features: unknown, options: DecisionOptions) => Promise<AiAssessment>;

/** One line of the capture file. `sampleWeight` is how many CSV transfers the row stands for. */
export interface CaptureLine {
  readonly txId: string;
  readonly sampleWeight: number;
  /** Calls spent on this transfer (1 + retries after an unavailable answer): cost counts all. */
  readonly attempts: number;
  readonly latencyMs: number;
  readonly assessment: AiAssessment;
}

export interface Sample {
  /** In CSV order. */
  readonly txIds: readonly string[];
  readonly weights: ReadonlyMap<string, number>;
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Every fraud row and every hard negative (rare, weight 1) plus `normalSample` NORMAL rows chosen by
 * a seeded hash order. A NORMAL row stands for `normalCount / normalSample` rows, so a weighted
 * count rebuilds the alert volume of the whole file without calling the API 100 000 times.
 */
export function selectSample(csvText: string, seed: string, normalSample: number): Sample {
  if (!Number.isSafeInteger(normalSample) || normalSample < 1) {
    throw new Error('normalSample must be a positive integer');
  }
  const { events, labels, scenarios } = parseTransactionCsv(csvText);
  const normal = events.filter(
    event => labels.get(event.transferId) !== '1' && scenarios.get(event.transferId) === 'NORMAL',
  );
  const picked = new Set(
    [...normal]
      .sort((a, b) => {
        const ha = digest(`${seed}:${a.transferId}`);
        const hb = digest(`${seed}:${b.transferId}`);
        return ha < hb ? -1 : ha > hb ? 1 : 0;
      })
      .slice(0, normalSample)
      .map(event => event.transferId),
  );
  const normalWeight = normal.length / Math.max(1, Math.min(normalSample, normal.length));
  const weights = new Map<string, number>();
  const txIds: string[] = [];
  for (const event of events) {
    const id = event.transferId;
    const isNormal = labels.get(id) !== '1' && scenarios.get(id) === 'NORMAL';
    if (isNormal && !picked.has(id)) continue;
    txIds.push(id);
    weights.set(id, isNormal ? normalWeight : 1);
  }
  return { txIds, weights };
}

export interface CaptureOptions {
  readonly csvText: string;
  readonly seed: string;
  readonly normalSample: number;
  readonly model: string;
  readonly rubric: string;
  readonly apiKey: string;
  readonly requestTimeoutMs: number;
  readonly concurrency: number;
  /** Stop before spending more than this many calls (every attempt counts). */
  readonly maxCalls: number;
  /** Only the first n transfers of the sample (a smoke run). */
  readonly limit?: number;
  /** Already captured transfers, skipped so an interrupted run resumes without paying twice. */
  readonly done: ReadonlySet<string>;
  readonly assess: AssessFn;
  /** Called once per finished transfer, as soon as it finishes. */
  readonly onLine: (line: CaptureLine) => void;
}

export interface CaptureSummary {
  readonly planned: number;
  readonly skipped: number;
  readonly captured: number;
  readonly calls: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly stoppedEarly: string | null;
}

const MAX_RETRIES = 2;
/** The first answers decide whether the key and the endpoint work at all. */
const FAIL_FAST_AFTER = 10;

export async function captureAi(options: CaptureOptions): Promise<CaptureSummary> {
  const { facts, events } = parseTransactionCsv(options.csvText);
  const sample = selectSample(options.csvText, options.seed, options.normalSample);
  const byId = new Map(events.map(event => [event.transferId, event]));
  const provider = new OfflineFeatureProvider(facts, OFFLINE_PER_TX_LIMIT);

  const wanted = sample.txIds.slice(0, options.limit ?? sample.txIds.length);
  const todo = wanted.filter(id => !options.done.has(id));
  const statusCounts: Record<string, number> = {};
  let calls = 0;
  let captured = 0;
  let next = 0;
  let stoppedEarly: string | null = null;
  let firstResults = 0;
  let firstFailures = 0;

  const worker = async (): Promise<void> => {
    while (stoppedEarly === null) {
      const index = next++;
      if (index >= todo.length) return;
      const id = todo[index];
      const input = await provider.extractAiInput(byId.get(id)!);
      let attempts = 0;
      let assessment: AiAssessment | undefined;
      const started = performance.now();
      while (attempts <= MAX_RETRIES) {
        if (calls >= options.maxCalls) {
          stoppedEarly = `call cap ${options.maxCalls} reached`;
          return;
        }
        calls += 1;
        attempts += 1;
        assessment = await options.assess(input, {
          enabled: true,
          apiKey: options.apiKey,
          model: options.model,
          rubric: options.rubric,
          requestTimeoutMs: options.requestTimeoutMs,
          maxAdmissionDelayMs: options.requestTimeoutMs,
          selectedAtMonotonicMs: performance.now(),
          tryAcquire: () => ({ kind: 'granted', release: () => undefined }),
        });
        if (assessment.status !== 'UNAVAILABLE') break;
      }
      const final = assessment!;
      statusCounts[final.status] = (statusCounts[final.status] ?? 0) + 1;
      captured += 1;
      options.onLine({
        txId: id,
        sampleWeight: sample.weights.get(id)!,
        attempts,
        latencyMs: Math.round(performance.now() - started),
        assessment: final,
      });
      if (firstResults < FAIL_FAST_AFTER) {
        firstResults += 1;
        if (final.status !== 'SUCCEEDED') firstFailures += 1;
        if (firstResults === FAIL_FAST_AFTER && firstFailures === FAIL_FAST_AFTER) {
          stoppedEarly = `the first ${FAIL_FAST_AFTER} answers all failed (key, model or network)`;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  return {
    planned: wanted.length,
    skipped: wanted.length - todo.length,
    captured,
    calls,
    statusCounts,
    stoppedEarly,
  };
}

/** Reads a capture file with its sampling weights, attempts and latency (same checks as `parseCapture`). */
export function parseCaptureLines(text: string): Map<string, CaptureLine> {
  const assessments = parseCapture(text);
  const lines = new Map<string, CaptureLine>();
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    const row = JSON.parse(raw) as Partial<CaptureLine> & { txId: string };
    const weight = row.sampleWeight ?? 1;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      throw new Error(`Capture ${row.txId}: sampleWeight must be a positive number`);
    }
    lines.set(row.txId, {
      txId: row.txId,
      sampleWeight: weight,
      attempts: typeof row.attempts === 'number' && row.attempts >= 1 ? row.attempts : 1,
      latencyMs: typeof row.latencyMs === 'number' ? row.latencyMs : 0,
      assessment: assessments.get(row.txId)!,
    });
  }
  return lines;
}
