import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCompareModes } from './compare-modes';

const HEADER =
  'tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario';
const OLD = '2024-01-01T00:00:00.000Z';
const row = (
  id: string,
  customer: string,
  minute: number,
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
    '500000',
    '1000000000',
    OLD,
    OLD,
    String(fraud),
    scenario,
  ].join(',');
const assessment = (p: number): object => ({
  status: 'SUCCEEDED',
  probability: p,
  provider: 'openai',
  requestedModel: 'm',
  responseModel: 'm-1',
  requestId: null,
  rubricSha256: 'r',
  inputSha256: null,
  usage: { inputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0 },
});
const CONFIG = {
  mode: 'rule_only',
  thresholds: { medium: 40, high: 70 },
  rules: {
    R1: { enabled: true, weight: 30, maxTransfers: 5, windowMinutes: 10 },
    R2: { enabled: true, weight: 25, medianMultiplier: 5, historyDays: 30, minHistory: 5 },
    R3: {
      enabled: true,
      weight: 45,
      maxAccountAgeHoursExclusive: 24,
      minAmountExclusive: '10000000',
    },
    R4: { enabled: true, weight: 20, reverseWindowMinutes: 60 },
    R5: {
      enabled: true,
      weight: 40,
      minNewRecipients: 5,
      windowMinutes: 60,
      noveltyDays: 30,
      sameOwnerExempt: true,
    },
    R6: {
      enabled: true,
      weight: 30,
      minBalancePercent: 90,
      minBalance: '1000000',
      sameOwnerExempt: true,
    },
  },
};

describe('compare-modes CLI (DBS-212)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbs212c-'));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('TC-212-16 prints the gate verdict and writes the report', async () => {
    const csv = [HEADER];
    const capture: string[] = [];
    for (let c = 0; c < 60; c++) {
      csv.push(
        row(`f${c}`, `cust-${c}`, c, 1, c % 2 === 1 ? 'SLOW_DRIP' : 'ATO_DRAIN'),
        row(`n${c}`, `cust-${c}`, c + 1, 0, 'NORMAL'),
      );
      capture.push(
        JSON.stringify({ txId: `f${c}`, sampleWeight: 1, assessment: assessment(0.95) }),
      );
      capture.push(
        JSON.stringify({ txId: `n${c}`, sampleWeight: 1000, assessment: assessment(0.1) }),
      );
    }
    const input = join(dir, 'tune.csv');
    const capturePath = join(dir, 'capture.jsonl');
    const config = join(dir, 'config.json');
    const output = join(dir, 'report.json');
    writeFileSync(input, csv.join('\n'));
    writeFileSync(capturePath, capture.join('\n'));
    writeFileSync(config, JSON.stringify(CONFIG));

    const report = await runCompareModes([
      ...['--input', input, '--capture', capturePath, '--config', config],
      ...['--seed', 'x', '--iterations', '100', '--output', output],
    ]);

    const printed = (console.log as jest.Mock).mock.calls.map(call => String(call[0])).join('\n');
    expect(printed).toContain('gate: INCOMPLETE');
    expect(printed).toContain('[not-measured] p95 transfer-to-flag');
    expect(JSON.parse(readFileSync(output, 'utf8')).gate.verdict).toBe(report.gate.verdict);
  });

  it.each([
    [['--capture', 'c', '--config', 'f', '--seed', 's'], /Missing required option: --input/],
    [['--input', 'i', '--config', 'f', '--seed', 's'], /Missing required option: --capture/],
    [['--input', 'i', '--capture', 'c', '--seed', 's'], /Missing required option: --config/],
    [['--input', 'i', '--capture', 'c', '--config', 'f'], /Missing required option: --seed/],
    [
      ['--input', 'i', '--capture', 'c', '--config', 'f', '--seed', 's', '--iterations', '0'],
      /Invalid --iterations/,
    ],
    [
      ['--input', 'i', '--capture', 'c', '--config', 'f', '--seed', 's', '--bogus'],
      /Unknown option '--bogus'/,
    ],
  ])('TC-212-17 refuses bad arguments %j', async (args, message) => {
    await expect(runCompareModes(args)).rejects.toThrow(message);
  });
});
