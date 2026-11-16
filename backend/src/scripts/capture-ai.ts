import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assess } from '../modules/risk/ai/openai-decisions';
import { REVIEW_RUBRIC } from '../modules/risk/ai/rubric';
import {
  captureAi,
  parseCaptureLines,
  selectSample,
  type AssessFn,
  type CaptureSummary,
} from '../modules/risk/evaluation/capture-ai';

const USAGE =
  'Usage: capture-ai --input <tune.csv> --output <capture.jsonl> --seed <text> --max-calls <n> ' +
  '[--normal-sample <n>] [--model <name>] [--concurrency <n>] [--timeout-ms <n>] [--limit <n>] ' +
  '[--dry-run]   (OPENAI_API_KEY comes from the environment, never from an argument)';

/** Planning figure only (docs/components/risk/05-evaluation-b0-baseline.md); real usage is read from the capture. */
const ASSUMED_INPUT_TOKENS = 1200;
const ASSUMED_USD_PER_MILLION_INPUT_TOKENS = 0.1;

interface Args {
  input?: string;
  output?: string;
  seed?: string;
  maxCalls?: number;
  normalSample: number;
  model: string;
  concurrency: number;
  timeoutMs: number;
  limit?: number;
  dryRun: boolean;
}

const positive = (text: string, name: string): number => {
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`Invalid ${name}: positive integer`);
  return Number(text);
};

function parseArgs(args: string[]): Args {
  const parsed: Args = {
    normalSample: 1000,
    model: 'gpt-6-luna',
    concurrency: 4,
    timeoutMs: 20_000,
    dryRun: false,
  };
  const value = (i: number, name: string): string => {
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${name}`);
    return next;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--input') parsed.input = value(i++, arg);
    else if (arg === '--output') parsed.output = value(i++, arg);
    else if (arg === '--seed') parsed.seed = value(i++, arg);
    else if (arg === '--model') parsed.model = value(i++, arg);
    else if (arg === '--max-calls') parsed.maxCalls = positive(value(i++, arg), arg);
    else if (arg === '--normal-sample') parsed.normalSample = positive(value(i++, arg), arg);
    else if (arg === '--concurrency') parsed.concurrency = positive(value(i++, arg), arg);
    else if (arg === '--timeout-ms') parsed.timeoutMs = positive(value(i++, arg), arg);
    else if (arg === '--limit') parsed.limit = positive(value(i++, arg), arg);
    else throw new Error(`Unknown option '${arg}'. ${USAGE}`);
  }
  for (const [name, set] of [
    ['--input', parsed.input],
    ['--output', parsed.output],
    ['--seed', parsed.seed],
    ['--max-calls', parsed.maxCalls],
  ] as const) {
    if (set === undefined) throw new Error(`Missing required option: ${name}. ${USAGE}`);
  }
  return parsed;
}

export interface CaptureRun {
  readonly summary: CaptureSummary | null;
  readonly planned: number;
  readonly estimatedUsd: number;
}

export async function runCaptureAi(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  assessFn: AssessFn = assess,
): Promise<CaptureRun> {
  const options = parseArgs(args);
  const csvText = readFileSync(resolve(process.cwd(), options.input!), 'utf8');
  const output = resolve(process.cwd(), options.output!);
  const done = existsSync(output)
    ? new Set(parseCaptureLines(readFileSync(output, 'utf8')).keys())
    : new Set<string>();

  const sample = selectSample(csvText, options.seed!, options.normalSample);
  const wanted = sample.txIds.slice(0, options.limit ?? sample.txIds.length);
  const remaining = wanted.filter(id => !done.has(id)).length;
  const estimatedUsd =
    (remaining * ASSUMED_INPUT_TOKENS * ASSUMED_USD_PER_MILLION_INPUT_TOKENS) / 1_000_000;
  console.log(
    `[capture-ai] sample ${wanted.length} transfers (${done.size} already captured, ` +
      `${remaining} to call), model ${options.model}, estimated cost ~$${estimatedUsd.toFixed(2)} ` +
      `(assumption: ${ASSUMED_INPUT_TOKENS} input tokens x $${ASSUMED_USD_PER_MILLION_INPUT_TOKENS}/1M, not a bill)`,
  );
  if (options.dryRun) return { summary: null, planned: wanted.length, estimatedUsd };

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey)
    throw new Error('OPENAI_API_KEY is not set (use node --env-file, never an argument)');
  if (remaining > options.maxCalls!) {
    throw new Error(
      `${remaining} calls needed but --max-calls is ${options.maxCalls}: raise it on purpose`,
    );
  }

  const summary = await captureAi({
    csvText,
    seed: options.seed!,
    normalSample: options.normalSample,
    model: options.model,
    rubric: REVIEW_RUBRIC,
    apiKey,
    requestTimeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    maxCalls: options.maxCalls!,
    limit: options.limit,
    done,
    assess: assessFn,
    onLine: line => appendFileSync(output, JSON.stringify(line) + '\n', 'utf8'),
  });
  const lines = parseCaptureLines(readFileSync(output, 'utf8'));
  let inputTokens = 0;
  let attempts = 0;
  for (const line of lines.values()) {
    inputTokens += line.assessment.usage?.inputTokens ?? 0;
    attempts += line.attempts;
  }
  const usd = (inputTokens * ASSUMED_USD_PER_MILLION_INPUT_TOKENS) / 1_000_000;
  console.log(
    `[capture-ai] captured ${summary.captured}/${summary.planned - summary.skipped}, ` +
      `${summary.calls} calls this run, status ${JSON.stringify(summary.statusCounts)}`,
  );
  console.log(
    `[capture-ai] file now holds ${lines.size} transfers, ${attempts} calls, ${inputTokens} input ` +
      `tokens (~$${usd.toFixed(4)} at the assumed price)`,
  );
  if (summary.stoppedEarly) console.log(`[capture-ai] STOPPED: ${summary.stoppedEarly}`);
  console.log(`[capture-ai] Capture written to: ${output}`);
  if (summary.stoppedEarly) process.exitCode = 1;
  return { summary, planned: wanted.length, estimatedUsd };
}

if (require.main === module) {
  void runCaptureAi(process.argv.slice(2)).catch(error => {
    console.error(`[capture-ai] Error: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
