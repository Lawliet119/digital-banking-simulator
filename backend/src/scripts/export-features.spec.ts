import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExportFeatures } from './export-features';

const HEADER =
  'tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario';
const ROW =
  'tx-1,2026-10-01T10:00:00.000Z,acc-A,acc-B,u-1,u-2,100000,500000,2026-09-01T00:00:00.000Z,2026-09-01T00:00:00.000Z,0,NORMAL';

describe('export-features CLI (DBS-211)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbs211-'));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('TC-211-05c writes the output file and reports the row count', async () => {
    const input = join(dir, 'in.csv');
    const output = join(dir, 'out.csv');
    writeFileSync(input, [HEADER, ROW].join('\n'));
    await runExportFeatures(['--input', input, '--output', output]);
    const lines = readFileSync(output, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].split(',')[0]).toBe('tx-1');
  });

  it.each([
    [['--output', 'x'], /Missing required option: --input/],
    [['--input', 'x'], /Missing required option: --output/],
    [['--input', 'x', '--output', 'y', '--bogus'], /Unknown option '--bogus'/],
    [['--input', 'x', '--output', 'y', '--per-tx-limit', '0'], /Invalid --per-tx-limit/],
    [['--input', 'x', '--output', 'y', '--per-tx-limit', 'abc'], /Invalid --per-tx-limit/],
  ])('TC-211-05d refuses bad arguments %j', async (args, message) => {
    await expect(runExportFeatures(args)).rejects.toThrow(message);
  });

  it('TC-211-05e a missing input file fails and writes nothing', async () => {
    const output = join(dir, 'out.csv');
    await expect(
      runExportFeatures(['--input', join(dir, 'missing.csv'), '--output', output]),
    ).rejects.toThrow(/ENOENT/);
    expect(() => readFileSync(output)).toThrow();
  });
});
