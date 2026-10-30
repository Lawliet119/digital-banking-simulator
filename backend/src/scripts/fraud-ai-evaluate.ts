import { performance } from 'node:perf_hooks';
import type { AiAssessment } from '../modules/risk/ai/ai-contract';
import { assess } from '../modules/risk/ai/openai-decisions';

const invalid: AiAssessment = {
  status: 'CONFIG_INVALID',
  probability: null,
  provider: null,
  requestedModel: null,
  responseModel: null,
  requestId: null,
  rubricSha256: null,
  inputSha256: null,
  usage: null,
};

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--live')) {
    console.log(JSON.stringify(invalid));
    process.exitCode = 2;
    return;
  }
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (Buffer.byteLength(raw) > 65536) {
      console.log(JSON.stringify(invalid));
      process.exitCode = 2;
      return;
    }
  }
  let features: unknown;
  try {
    features = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify(invalid));
    process.exitCode = 2;
    return;
  }
  const selectedAtMonotonicMs = performance.now();
  const result = await assess(features, {
    enabled: args[0] === '--live',
    apiKey: process.env.OPENAI_API_KEY ?? null,
    model: 'gpt-6-luna',
    requestTimeoutMs: 10000,
    maxAdmissionDelayMs: 1000,
    selectedAtMonotonicMs,
    tryAcquire: () => ({ kind: 'granted', release: () => undefined }),
  });
  console.log(JSON.stringify(result));
  if (result.status === 'CONFIG_INVALID') process.exitCode = 2;
  else if (result.status !== 'SUCCEEDED' && result.status !== 'DISABLED') process.exitCode = 1;
}

void run().catch(() => {
  console.log(JSON.stringify(invalid));
  process.exitCode = 2;
});
