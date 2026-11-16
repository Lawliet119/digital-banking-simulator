import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiAssessment } from '../modules/risk/ai/ai-contract';
import { runCaptureAi } from './capture-ai';

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

const answer: AiAssessment = {
  status: 'SUCCEEDED',
  probability: 0.3,
  provider: 'openai',
  requestedModel: 'm',
  responseModel: 'm-1',
  requestId: null,
  rubricSha256: 'r',
  inputSha256: null,
  usage: { inputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0 },
};

describe('capture-ai CLI (DBS-212)', () => {
  let dir: string;
  let input: string;
  let output: string;
  const base = (): string[] => [
    ...['--input', input, '--output', output, '--seed', 's'],
    ...['--normal-sample', '3', '--max-calls', '50'],
  ];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbs212-'));
    input = join(dir, 'tune.csv');
    output = join(dir, 'capture.jsonl');
    // 2 fraud + 10 NORMAL; the sample is 2 + 3 = 5 transfers
    writeFileSync(
      input,
      [
        HEADER,
        row(1, 1, 'ATO_DRAIN'),
        row(2, 1, 'SLOW_DRIP'),
        ...Array.from({ length: 10 }, (_, i) => row(10 + i, 0, 'NORMAL')),
      ].join('\n'),
    );
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('TC-212-12 a dry run plans and prices the sample without calling the API', async () => {
    const assess = jest.fn();
    const run = await runCaptureAi([...base(), '--dry-run'], {}, assess);
    expect(assess).not.toHaveBeenCalled();
    expect(run).toMatchObject({ planned: 5, summary: null });
    expect(run.estimatedUsd).toBeCloseTo((5 * 1200 * 0.1) / 1_000_000, 10);
  });

  it('TC-212-13 refuses to call without a key or with a cap below the calls needed', async () => {
    const assess = jest.fn();
    await expect(runCaptureAi(base(), {}, assess)).rejects.toThrow(/OPENAI_API_KEY is not set/);
    await expect(
      runCaptureAi([...base().slice(0, -2), '--max-calls', '2'], { OPENAI_API_KEY: 'k' }, assess),
    ).rejects.toThrow(/5 calls needed but --max-calls is 2/);
    expect(assess).not.toHaveBeenCalled();
  });

  it('TC-212-14 writes the capture and a second run resumes with no new call', async () => {
    const assess = jest.fn(() => Promise.resolve(answer));
    await runCaptureAi(base(), { OPENAI_API_KEY: 'sk-secret' }, assess);
    expect(assess).toHaveBeenCalledTimes(5);
    const text = readFileSync(output, 'utf8');
    expect(text.trim().split('\n')).toHaveLength(5);
    expect(text).not.toContain('sk-secret');

    await runCaptureAi(base(), { OPENAI_API_KEY: 'sk-secret' }, assess);
    expect(assess).toHaveBeenCalledTimes(5);
  });

  it('TC-161-03 sends the rubric from --rubric-file instead of the default one and refuses an empty file', async () => {
    const rubricPath = join(dir, 'rubric.txt');
    writeFileSync(rubricPath, '  candidate rubric text \n');
    const assess = jest.fn((_features: unknown, _options: { rubric: string }) =>
      Promise.resolve(answer),
    );
    await runCaptureAi([...base(), '--rubric-file', rubricPath], { OPENAI_API_KEY: 'k' }, assess);
    const calls = assess.mock.calls;
    expect(calls).toHaveLength(5);
    expect(calls.every(([, options]) => options.rubric === 'candidate rubric text')).toBe(true);

    writeFileSync(rubricPath, '  \n');
    await expect(
      runCaptureAi([...base(), '--rubric-file', rubricPath], { OPENAI_API_KEY: 'k' }, assess),
    ).rejects.toThrow(/--rubric-file is empty/);
  });

  it.each([
    [['--output', 'o', '--seed', 's', '--max-calls', '1'], /Missing required option: --input/],
    [['--input', 'i', '--seed', 's', '--max-calls', '1'], /Missing required option: --output/],
    [['--input', 'i', '--output', 'o', '--max-calls', '1'], /Missing required option: --seed/],
    [['--input', 'i', '--output', 'o', '--seed', 's'], /Missing required option: --max-calls/],
    [['--input', 'i', '--output', 'o', '--seed', 's', '--max-calls', '0'], /Invalid --max-calls/],
    [['--input', 'i', '--output', 'o', '--seed', 's', '--bogus'], /Unknown option '--bogus'/],
    [['--input', 'i', '--output', 'o', '--seed'], /Missing value for --seed/],
  ])('TC-212-15 refuses bad arguments %j', async (args, message) => {
    await expect(runCaptureAi(args, {}, jest.fn())).rejects.toThrow(message);
  });
});
