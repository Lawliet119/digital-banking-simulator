import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AiAssessment, AiStatus, DecisionOptions } from './ai-contract';
import { projectFeatures } from './feature-projection';
import { REVIEW_QUESTION, REVIEW_RUBRIC } from './rubric';

const ENDPOINT = 'https://api.openai.com/v1/decisions';
const RESPONSE_LIMIT = 65536;
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const RUBRIC_HASH = hash(REVIEW_RUBRIC);

function empty(status: AiStatus): AiAssessment {
  return {
    status,
    probability: null,
    provider: null,
    requestedModel: null,
    responseModel: null,
    requestId: null,
    rubricSha256: null,
    inputSha256: null,
    usage: null,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function usage(value: unknown): AiAssessment['usage'] {
  const source = object(value);
  const details = object(source?.input_tokens_details);
  const values = [source?.input_tokens, details?.cached_tokens, details?.cache_write_tokens];
  if (values.some(v => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)) return null;
  return {
    inputTokens: values[0] as number,
    cachedTokens: values[1] as number,
    cacheWriteTokens: values[2] as number,
  };
}

function safeMetadata(value: unknown, secret: string): string | null {
  return typeof value === 'string' &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(value) &&
    !value.includes(secret)
    ? value
    : null;
}

async function readBody(response: Response, controller: AbortController): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = next.value as Uint8Array;
      length += bytes.byteLength;
      if (length > RESPONSE_LIMIT) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

function createAdapter(endpoint: string) {
  return async function evaluate(
    features: unknown,
    options: DecisionOptions,
  ): Promise<AiAssessment> {
    let projected;
    try {
      projected = projectFeatures(features);
    } catch {
      return empty('CONFIG_INVALID');
    }
    if (!options.enabled || !options.apiKey) return empty('DISABLED');
    if (
      typeof options.apiKey !== 'string' ||
      options.apiKey.trim() !== options.apiKey ||
      typeof options.model !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.model) ||
      options.model.includes(options.apiKey) ||
      !Number.isSafeInteger(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0 ||
      options.requestTimeoutMs > 2147483647 ||
      !Number.isSafeInteger(options.maxAdmissionDelayMs) ||
      options.maxAdmissionDelayMs <= 0 ||
      !Number.isFinite(options.selectedAtMonotonicMs) ||
      typeof options.tryAcquire !== 'function'
    ) {
      return empty('CONFIG_INVALID');
    }
    const result: AiAssessment = {
      ...empty('UNAVAILABLE'),
      provider: 'openai',
      requestedModel: options.model,
      rubricSha256: RUBRIC_HASH,
      inputSha256: hash(JSON.stringify(projected)),
    };
    const expired = (): boolean =>
      performance.now() - options.selectedAtMonotonicMs > options.maxAdmissionDelayMs;
    if (expired()) return result;
    let permit;
    try {
      permit = options.tryAcquire();
    } catch {
      return result;
    }
    if (permit.kind === 'budget_exhausted') return { ...result, status: 'BUDGET_EXHAUSTED' };
    if (permit.kind !== 'granted') return result;
    try {
      if (expired()) return result;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: options.model,
            input: [{ role: 'user', content: [{ type: 'input_json', data: projected }] }],
            questions: [{ type: 'predicate', name: REVIEW_QUESTION, instructions: REVIEW_RUBRIC }],
          }),
        });
        if (!response.ok) {
          controller.abort();
          return result;
        }
        const raw = await readBody(response, controller);
        if (raw === null) return { ...result, status: 'INVALID_RESPONSE' };
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return { ...result, status: 'INVALID_RESPONSE' };
        }
        const data = object(parsed);
        const provenance = {
          responseModel: safeMetadata(data?.model, options.apiKey),
          requestId: safeMetadata(response.headers.get('x-request-id'), options.apiKey),
          usage: usage(data?.usage),
        };
        if (!Array.isArray(data?.answers) || data.answers.length !== 1)
          return { ...result, ...provenance, status: 'INVALID_RESPONSE' };
        const answer = object(data.answers[0]);
        if (answer?.name !== REVIEW_QUESTION)
          return { ...result, ...provenance, status: 'INVALID_RESPONSE' };
        if (answer.type === 'refusal') return { ...result, ...provenance, status: 'REFUSED' };
        const p = answer.probability;
        if (
          answer.type !== 'predicate' ||
          typeof p !== 'number' ||
          !Number.isFinite(p) ||
          p < 0 ||
          p > 1
        ) {
          return { ...result, ...provenance, status: 'INVALID_RESPONSE' };
        }
        return { ...result, ...provenance, status: 'SUCCEEDED', probability: p };
      } catch {
        return result;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      permit.release();
    }
  };
}

export const assess = createAdapter(ENDPOINT);

/** Internal test seam: never accepts remote endpoints or production configuration. */
export function createLoopbackAdapter(endpoint: string): typeof assess {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('Expected a loopback HTTP endpoint');
  }
  return createAdapter(url.toString());
}
