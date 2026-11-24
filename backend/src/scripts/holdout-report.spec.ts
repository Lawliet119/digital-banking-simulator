import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FreezeManifest } from '../modules/risk/evaluation/freeze';
import { runHoldoutReport, type HoldoutFile } from './holdout-report';

const BACKEND = resolve(__dirname, '..', '..');
const MANIFEST_PATH = join(BACKEND, 'src/modules/risk/evaluation/configs/freeze-manifest.json');
const HEADER =
  'tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario';
const RUBRIC = '96e0b08fadcbd7ec2fdadd71f59569e02b7273db453d657acd44ade7c5f9a0ff';

const row = (
  id: string,
  customer: string,
  minute: number,
  amount: string,
  createdAt: string,
  fraud: 0 | 1,
  scenario: string,
): string =>
  [
    id,
    `2026-10-01T10:${String(minute % 60).padStart(2, '0')}:00.000Z`,
    `from-${id}`,
    `to-${id}`,
    customer,
    `to-${customer}`,
    amount,
    '1000000000',
    createdAt,
    '2024-01-01T00:00:00.000Z',
    String(fraud),
    scenario,
  ].join(',');

/** 20 customers; every transfer is captured with weight 1 (the way a holdout capture is made). */
function holdout(rubric = RUBRIC): { csv: string; capture: string } {
  const lines = [HEADER];
  const capture: string[] = [];
  const put = (id: string, probability: number): void => {
    capture.push(
      JSON.stringify({
        txId: id,
        sampleWeight: 1,
        attempts: 1,
        latencyMs: 120,
        assessment: {
          status: 'SUCCEEDED',
          probability,
          provider: 'openai',
          requestedModel: 'gpt-6-luna',
          responseModel: 'gpt-6-luna',
          requestId: null,
          rubricSha256: rubric,
          inputSha256: null,
          usage: { inputTokens: 500, cachedTokens: 0, cacheWriteTokens: 0 },
        },
      }),
    );
  };
  for (let c = 0; c < 20; c++) {
    const customer = `cust-${c}`;
    lines.push(row(`f${c}`, customer, c, '500000', '2024-01-01T00:00:00.000Z', 1, 'ATO_DRAIN'));
    lines.push(row(`n${c}`, customer, c + 1, '500000', '2024-01-01T00:00:00.000Z', 0, 'NORMAL'));
    put(`f${c}`, 0.9);
    put(`n${c}`, 0.1);
  }
  return { csv: lines.join('\n'), capture: capture.join('\n') + '\n' };
}

let dir: string;
let logs: string[];
const log = (line: string): void => {
  logs.push(line);
};

/** The real manifest, minus the engine files (they are checked by freeze.spec and `freeze:verify`). */
function manifest(tuneCsvSha256 = 'f'.repeat(64)): FreezeManifest {
  const real = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FreezeManifest;
  return {
    ...real,
    tune: { ...real.tune, csvSha256: tuneCsvSha256 },
    engine: { files: {} },
    amendments: [],
  };
}
const path = (name: string): string => join(dir, name);
const run = (args: string[], m: FreezeManifest = manifest()): Promise<number> =>
  runHoldoutReport(args, { backendRoot: BACKEND, manifest: m, log });
const report = (name = 'report.json'): HoldoutFile =>
  JSON.parse(readFileSync(path(name), 'utf8')) as HoldoutFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'holdout-report-'));
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('holdout-report CLI (BL-407)', () => {
  const base = (): string[] => [
    '--input',
    path('holdout.csv'),
    '--capture',
    path('capture.jsonl'),
    '--output',
    path('report.json'),
    '--iterations',
    '50',
  ];
  const write = (data = holdout()): void => {
    writeFileSync(path('holdout.csv'), data.csv);
    writeFileSync(path('capture.jsonl'), data.capture);
  };

  it('TC-407-20 measures a holdout with the frozen parameters and stamps where it came from', async () => {
    write();
    expect(await run(base())).toBe(0);
    const file = report();
    expect(file.kind).toBe('holdout');
    expect(file.freezeId).toBe('DBS-168');
    expect(file.inputs.csvSha256).toBe(
      createHash('sha256')
        .update(readFileSync(path('holdout.csv')))
        .digest('hex'),
    );
    expect(file.inputs.captureSha256).toHaveLength(64);
    expect(file.report.parameters).toMatchObject({
      ruleOnlyVersion: 4,
      withAiVersion: 5,
      ai: { model: 'gpt-6-luna', threshold: 0.65, weight: 40 },
    });
    expect(file.report.sample).toMatchObject({ transfers: 40, fraud: 20, fullCapture: true });
    // B1 flags the 20 fraud rows (0.9 >= 0.65) and no NORMAL row (0.1).
    expect(file.report.modes.b1).toMatchObject({ tp: 20, fp: 0, recall: 1, precision: 1 });
    expect(file.report.provenance.responseModels).toEqual(['gpt-6-luna']);
    expect(logs.some(l => l.includes('Report written to'))).toBe(true);
  });

  it('TC-407-21 an existing report is never replaced', async () => {
    write();
    writeFileSync(path('report.json'), 'earlier run');
    expect(await run(base())).toBe(1);
    expect(readFileSync(path('report.json'), 'utf8')).toBe('earlier run');
    expect(logs.some(l => /already exists/.test(l))).toBe(true);
  });

  it('TC-407-22 the tune file is refused as a holdout and accepted, stamped, as a dry run', async () => {
    const data = holdout();
    write(data);
    const tune = manifest(createHash('sha256').update(data.csv).digest('hex'));
    expect(await run(base(), tune)).toBe(1);
    expect(logs.some(l => /tune file, not a holdout/.test(l))).toBe(true);
    logs = [];
    expect(await run([...base(), '--allow-tune'], tune)).toBe(0);
    const file = report();
    expect(file.kind).toBe('tune-dry-run');
    expect(logs.some(l => l.includes('NOT a holdout result'))).toBe(true);
  });

  it('TC-407-23 --allow-tune is refused for a file that is not the recorded tune file', async () => {
    write();
    expect(await run([...base(), '--allow-tune'])).toBe(1);
    expect(logs.some(l => /only for the tune file/.test(l))).toBe(true);
  });

  it('TC-407-24 a holdout capture made with another rubric is refused before anything is measured', async () => {
    write(holdout('0'.repeat(64)));
    expect(await run(base())).toBe(1);
    expect(logs.some(l => /rubricSha256/.test(l))).toBe(true);
    expect(() => readFileSync(path('report.json'))).toThrow();
  });

  it('TC-407-25 a holdout capture that does not cover every transfer is refused', async () => {
    const data = holdout();
    write({ csv: data.csv, capture: data.capture.split('\n').slice(2).join('\n') });
    expect(await run(base())).toBe(1);
    expect(logs.some(l => /not in the capture/.test(l))).toBe(true);
  });

  it('TC-407-26 a frozen configuration that changed is refused', async () => {
    write();
    const real = manifest();
    const drifted: FreezeManifest = {
      ...real,
      modes: {
        ...real.modes,
        rule_only: { ...real.modes.rule_only, configSha256: '0'.repeat(64) },
      },
    };
    expect(await run(base(), drifted)).toBe(1);
    expect(logs.some(l => /not frozen as recorded/.test(l))).toBe(true);
    expect(() => readFileSync(path('report.json'))).toThrow();
  });

  it('TC-407-27 missing options are a usage error', async () => {
    expect(await run(['--input', 'x'])).toBe(2);
    expect(await run(['--bogus'])).toBe(2);
    expect(await run([...base(), '--iterations', '0'])).toBe(2);
  });
});
