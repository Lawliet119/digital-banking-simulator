import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvaluateRules } from './evaluate-rules';

const HEADER =
  'tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario';
const FRAUD_ROW =
  'tx-1,2026-10-01T10:00:00.000Z,acc-A,acc-B,u-1,u-2,20000000,1000000000,2026-10-01T09:00:00.000Z,2024-01-01T00:00:00.000Z,1,ATO_DRAIN';
const NORMAL_ROW =
  'tx-2,2026-10-01T10:05:00.000Z,acc-C,acc-D,u-3,u-4,500000,1000000000,2024-01-01T00:00:00.000Z,2024-01-01T00:00:00.000Z,0,NORMAL';
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

describe('evaluate-rules CLI (DBS-132)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbs132-'));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('TC-132-09 prints the config version and seed and writes the report file', async () => {
    const input = join(dir, 'tune.csv');
    const config = join(dir, 'config.json');
    const output = join(dir, 'report.json');
    writeFileSync(input, [HEADER, FRAUD_ROW, NORMAL_ROW].join('\n'));
    writeFileSync(config, JSON.stringify(CONFIG));

    await runEvaluateRules([
      ...['--input', input, '--config', config, '--config-version', '3'],
      ...['--seed', 'my-seed', '--output', output],
    ]);

    const printed = (console.log as jest.Mock).mock.calls.map(call => String(call[0])).join('\n');
    expect(printed).toContain('config version 3, mode rule_only');
    expect(printed).toContain('seed my-seed');
    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.metrics).toMatchObject({ tp: 1, fp: 0, fn: 0, tn: 1, recall: 1, precision: 1 });
  });

  it.each([
    [['--config', 'c'], /Missing required option: --input/],
    [['--input', 'i'], /Missing required option: --config/],
    [['--input', 'i', '--config', 'c', '--bogus'], /Unknown option '--bogus'/],
    [['--input', 'i', '--config', 'c', '--config-version', '0'], /Invalid --config-version/],
    [['--input', 'i', '--config'], /Missing value for --config/],
  ])('TC-132-10 refuses bad arguments %j', async (args, message) => {
    await expect(runEvaluateRules(args)).rejects.toThrow(message);
  });

  it('TC-132-11 a missing input file fails and writes no report', async () => {
    const output = join(dir, 'report.json');
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify(CONFIG));
    await expect(
      runEvaluateRules(['--input', join(dir, 'nope.csv'), '--config', config, '--output', output]),
    ).rejects.toThrow(/ENOENT/);
    expect(() => readFileSync(output)).toThrow();
  });
});
