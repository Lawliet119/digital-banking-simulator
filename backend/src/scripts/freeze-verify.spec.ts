import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FreezeManifest } from '../modules/risk/evaluation/freeze';
import { runFreezeVerify } from './freeze-verify';

const BACKEND = resolve(__dirname, '..', '..');
const EVIDENCE = resolve(BACKEND, '..', 'docs', 'components', 'risk', 'evidence');
const seed = JSON.parse(
  readFileSync(resolve(BACKEND, 'src/modules/risk/evaluation/configs/v1.json'), 'utf8'),
) as unknown;

const real = JSON.parse(
  readFileSync(
    resolve(BACKEND, 'src/modules/risk/evaluation/configs/freeze-manifest.json'),
    'utf8',
  ),
) as FreezeManifest;
/** The engine files are checked by the CLI only, never by `npm test`: these runs leave them out. */
const withoutEngine: FreezeManifest = { ...real, engine: { files: {} } };

async function run(
  args: string[],
  fetchRows?: (url: string) => Promise<{ version: number; config: unknown }[]>,
  manifest: FreezeManifest = withoutEngine,
) {
  const lines: string[] = [];
  const code = await runFreezeVerify(args, { log: line => lines.push(line), fetchRows, manifest });
  return { code, text: lines.join('\n') };
}

describe('freeze-verify CLI (DBS-168)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'freeze-verify-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('TC-168-14a no argument: every group is OK, exit 0, the frozen values are printed', async () => {
    const { code, text } = await run([]);
    expect(code).toBe(0);
    expect(text).toContain('FROZEN AS RECORDED');
    expect(text).toContain(
      'rubricSha256 96e0b08fadcbd7ec2fdadd71f59569e02b7273db453d657acd44ade7c5f9a0ff',
    );
    expect(text).toContain('ai.threshold 0.65');
    expect(text).not.toContain('FAIL');
  });

  it('TC-168-14b unknown or incomplete options exit 2 with the usage', async () => {
    for (const args of [
      ['--bogus'],
      ['--capture'],
      ['--database-url', '--capture', 'x'],
      ['--input', 'holdout.csv'],
    ]) {
      const { code, text } = await run(args);
      expect(code).toBe(2);
      expect(text).toContain('Usage: freeze-verify');
    }
  });

  it('TC-168-14c the capture of the tune with rubric r4 passes, the one with the original rubric fails', async () => {
    const good = await run(['--capture', join(EVIDENCE, 'ai-gate-capture-tune-r4.jsonl')]);
    expect(good.code).toBe(0);
    expect(good.text).toContain('responseModel gpt-6-luna');
    expect(good.text).toContain('sample NOT checked');
    expect(good.text).not.toContain('WARN');
    const original = await run(['--capture', join(EVIDENCE, 'ai-gate-capture-tune.jsonl')]);
    expect(original.code).toBe(1);
    expect(original.text).toContain('FAIL  capture');
    const missing = await run(['--capture', join(dir, 'absent.jsonl')]);
    expect(missing.code).toBe(1);
  });

  it('TC-168-14e the engine files are checked by the CLI: a drifted file fails, and its name is printed', async () => {
    const drifted: FreezeManifest = {
      ...real,
      engine: {
        files: { ...real.engine.files, 'src/modules/risk/scoring.service.ts': '0'.repeat(64) },
      },
    };
    const { code, text } = await run([], undefined, drifted);
    expect(code).toBe(1);
    expect(text).toContain('FAIL  engine files: src/modules/risk/scoring.service.ts');
    expect(text).toContain('NOT FROZEN AS RECORDED');
    expect((await run([])).text).toContain('fingerprint');
  });

  it('TC-168-14d --database-url: a fresh database passes, a drifted seed fails, a read error fails', async () => {
    const fresh = await run(['--database-url', 'postgres://unused'], () =>
      Promise.resolve([{ version: 1, config: seed }]),
    );
    expect(fresh.code).toBe(0);
    expect(fresh.text).toContain('rule_only not created in risk_rule_sets');
    expect(fresh.text).toContain('active version 1 (rule_only)');
    expect(fresh.text).not.toContain('postgres://');

    const drifted = await run(['--database-url', 'postgres://unused'], () =>
      Promise.resolve([{ version: 1, config: { mode: 'rule_only' } }]),
    );
    expect(drifted.code).toBe(1);

    const broken = await run(['--database-url', 'postgres://unused'], () =>
      Promise.reject(new Error('connection refused')),
    );
    expect(broken.code).toBe(1);
    expect(broken.text).toContain('connection refused');
  });
});
