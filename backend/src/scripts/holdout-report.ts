import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCaptureLines } from '../modules/risk/evaluation/capture-ai';
import {
  engineFingerprint,
  verifyCapture,
  verifyEngine,
  verifyFreeze,
  type FreezeManifest,
  type ReadText,
} from '../modules/risk/evaluation/freeze';
import { measureHoldout, type HoldoutReport } from '../modules/risk/evaluation/holdout-report';

const MANIFEST = 'src/modules/risk/evaluation/configs/freeze-manifest.json';
const USAGE =
  'Usage: holdout-report --input <holdout.csv> --capture <holdout-capture.jsonl> --output <report.json> ' +
  '[--allow-tune] [--iterations <n>]  (run from backend/; fixed parameters only, DBS-169)';

export interface HoldoutReportDeps {
  readonly backendRoot?: string;
  /** Test seam: check this manifest instead of the one in the repository. */
  readonly manifest?: FreezeManifest;
  readonly log?: (line: string) => void;
}

/** What the file on disk holds: the measurement plus everything needed to audit where it came from. */
export interface HoldoutFile {
  /** `holdout` is the one-time run (DBS-169); `tune-dry-run` proves the tool on the tune file. */
  readonly kind: 'holdout' | 'tune-dry-run';
  readonly freezeId: string;
  readonly engineFingerprint: string;
  readonly amendments: readonly string[];
  readonly inputs: {
    readonly csvSha256: string;
    readonly captureSha256: string;
    readonly ruleOnlyConfigSha256: string;
    readonly withAiConfigSha256: string;
  };
  readonly captureWarnings: readonly string[];
  readonly report: HoldoutReport;
}

interface Args {
  input?: string;
  capture?: string;
  output?: string;
  allowTune: boolean;
  iterations?: number;
}

function parseArgs(args: readonly string[]): Args {
  const parsed: Args = { allowTune: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--allow-tune') {
      parsed.allowTune = true;
      continue;
    }
    const next = args[i + 1];
    if (arg === '--input' || arg === '--capture' || arg === '--output' || arg === '--iterations') {
      if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--iterations') {
        if (!/^[1-9]\d*$/.test(next)) throw new Error('Invalid --iterations: positive integer');
        parsed.iterations = Number(next);
      } else if (arg === '--input') parsed.input = next;
      else if (arg === '--capture') parsed.capture = next;
      else parsed.output = next;
      i++;
    } else throw new Error(`Unknown option '${arg}'`);
  }
  for (const [name, set] of [
    ['--input', parsed.input],
    ['--capture', parsed.capture],
    ['--output', parsed.output],
  ] as const) {
    if (!set) throw new Error(`Missing required option: ${name}`);
  }
  return parsed;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;

export function formatSummary(file: HoldoutFile): string[] {
  const r = file.report;
  const mode = (label: string, m: HoldoutReport['modes']['b0']): string =>
    `${label}: precision=${pct(m.precision)} recall=${pct(m.recall)} (in scope ${pct(m.inScopeRecall)}) ` +
    `F1=${pct(m.f1)} alerts/1000=${m.alertsPer1000} (tp ${m.tp}, fp ${m.fp}, fn ${m.fn}, tn ${m.tn})`;
  const lines = [
    `kind: ${file.kind}${file.kind === 'tune-dry-run' ? ' (NOT a holdout result)' : ''}; freeze ${file.freezeId}, engine fingerprint ${file.engineFingerprint}`,
    `sample: ${r.sample.transfers} transfers (${r.sample.fraud} fraud) of ${r.sample.customers} customers, ${r.sample.fullCapture ? 'every transfer captured' : 'sparse weighted capture'}`,
    `parameters (frozen, not chosen): thresholds medium ${r.parameters.thresholds.medium} / high ${r.parameters.thresholds.high}, AI ${r.parameters.ai.model} threshold ${r.parameters.ai.threshold} weight ${r.parameters.ai.weight}`,
    mode('B0', r.modes.b0),
    mode('B1', r.modes.b1),
    mode('B2', r.modes.b2),
    `recall gain B2-B0: overall ${(r.bootstrap.recallGain.overall.point * 100).toFixed(2)} pts ` +
      `[${(r.bootstrap.recallGain.overall.low * 100).toFixed(2)}, ${(r.bootstrap.recallGain.overall.high * 100).toFixed(2)}], ` +
      `in-scope ${(r.bootstrap.recallGain.inScope.point * 100).toFixed(2)} pts ` +
      `[${(r.bootstrap.recallGain.inScope.low * 100).toFixed(2)}, ${(r.bootstrap.recallGain.inScope.high * 100).toFixed(2)}] ` +
      `(${r.bootstrap.iterations} draws by customer)`,
    `alerts/1000: B0 ${r.bootstrap.alertsPer1000.b0.point} [${r.bootstrap.alertsPer1000.b0.low}, ${r.bootstrap.alertsPer1000.b0.high}], ` +
      `B2 ${r.bootstrap.alertsPer1000.b2.point} [${r.bootstrap.alertsPer1000.b2.low}, ${r.bootstrap.alertsPer1000.b2.high}]`,
    `average precision: B0 ${r.curves.averagePrecision.b0}, B1 ${r.curves.averagePrecision.b1}, B2 ${r.curves.averagePrecision.b2}`,
    'recall by scenario (B0 / B1 / B2):',
    ...r.byScenario.map(
      s =>
        `  ${s.scenario}${s.inScope ? '' : ' (out of scope)'} n=${s.fraud}: ${pct(s.b0)} / ${pct(s.b1)} / ${pct(s.b2)}`,
    ),
    'ablation (recall change when one rule is removed, B0 / B2):',
    ...r.ablation.rules.map(
      a =>
        `  ${a.rule}: ${(a.b0.deltaRecall * 100).toFixed(2)} pts / ${(a.b2.deltaRecall * 100).toFixed(2)} pts`,
    ),
    `provenance: provider ${r.provenance.providers.join(',') || '(none)'}, requested ${r.provenance.requestedModels.join(',') || '(none)'}, ` +
      `responseModel ${r.provenance.responseModels.join(',') || '(none)'} (record it), rubricSha256 ${r.provenance.rubricSha256.join(',') || '(none)'}, ` +
      `status ${JSON.stringify(r.provenance.statusCounts)}`,
    `cost: ${r.cost.calls} calls, ${r.cost.inputTokens} input tokens, ~$${r.cost.usd}; call latency p50 ${r.cost.callLatencyMs.p50} ms, p95 ${r.cost.callLatencyMs.p95} ms`,
    `gate: ${r.gate.verdict}`,
    ...r.gate.items.map(item => `  [${item.status}] ${item.name}: ${item.detail}`),
  ];
  for (const warning of [...file.captureWarnings, ...r.leakageWarnings]) {
    lines.push(`WARNING: ${warning}`);
  }
  return lines;
}

/** Exit code: 0 measured and written, 1 refused (frozen value differs, wrong file, output exists), 2 bad usage. */
export async function runHoldoutReport(
  args: readonly string[],
  deps: HoldoutReportDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const say = (line: string): void => log(`[holdout-report] ${line}`);
  let options: Args;
  try {
    options = parseArgs(args);
  } catch (error) {
    say(`Error: ${(error as Error).message}. ${USAGE}`);
    return 2;
  }
  const root = deps.backendRoot ?? resolve(__dirname, '..', '..');
  const read: ReadText = path => {
    try {
      return readFileSync(resolve(root, path), 'utf8');
    } catch {
      return undefined;
    }
  };
  const manifestText = deps.manifest ? '' : read(MANIFEST);
  if (manifestText === undefined) {
    say(`Error: ${MANIFEST} is missing`);
    return 1;
  }
  const manifest = deps.manifest ?? (JSON.parse(manifestText) as FreezeManifest);

  // 1. The parameters are the frozen ones, or nothing is measured.
  const frozenProblems = [...verifyFreeze(manifest, read), ...verifyEngine(manifest, read)];
  if (frozenProblems.length > 0) {
    for (const problem of frozenProblems) say(`FAIL  ${problem}`);
    say('Refused: the configuration or the engine is not frozen as recorded, nothing was measured');
    return 1;
  }

  // 2. The inputs are what the kind of run says they are.
  let csvText: string;
  let captureText: string;
  try {
    csvText = readFileSync(resolve(process.cwd(), options.input!), 'utf8');
    captureText = readFileSync(resolve(process.cwd(), options.capture!), 'utf8');
  } catch {
    say('Error: cannot read --input or --capture');
    return 1;
  }
  const csvSha256 = sha256(csvText);
  const isTune = csvSha256 === manifest.tune.csvSha256;
  if (isTune && !options.allowTune) {
    say(
      'Refused: this is the tune file, not a holdout. Pass --allow-tune for a dry run that is stamped as one',
    );
    return 1;
  }
  if (!isTune && options.allowTune) {
    say('Refused: --allow-tune is only for the tune file recorded in the freeze manifest');
    return 1;
  }
  const check = verifyCapture(manifest, captureText, isTune ? undefined : csvText);
  if (check.problems.length > 0) {
    for (const problem of check.problems) say(`FAIL  capture: ${problem}`);
    say('Refused: the capture is not the frozen one, nothing was measured');
    return 1;
  }

  // 3. One run, one report: an existing report is never replaced (a second run turns the holdout into tune data).
  const output = resolve(process.cwd(), options.output!);
  if (existsSync(output)) {
    say(`Refused: ${options.output} already exists; a holdout is measured once (09 §5)`);
    return 1;
  }

  const { rule_only: ruleOnly, rules_with_external_ai: withAi } = manifest.modes;
  const report = await measureHoldout({
    csvText,
    ruleOnly: {
      config: JSON.parse(read(ruleOnly.configFile)!) as unknown,
      version: ruleOnly.evaluationVersion,
    },
    withAi: {
      config: JSON.parse(read(withAi.configFile)!) as unknown,
      version: withAi.evaluationVersion,
    },
    capture: parseCaptureLines(captureText),
    requireFullCapture: !isTune,
    bootstrapSeed: manifest.freezeId,
    iterations: options.iterations,
  });
  const file: HoldoutFile = {
    kind: isTune ? 'tune-dry-run' : 'holdout',
    freezeId: manifest.freezeId,
    engineFingerprint: engineFingerprint(manifest),
    amendments: manifest.amendments.map(a => a.id),
    inputs: {
      csvSha256,
      captureSha256: sha256(captureText),
      ruleOnlyConfigSha256: ruleOnly.configSha256,
      withAiConfigSha256: withAi.configSha256,
    },
    captureWarnings: check.warnings,
    report,
  };
  writeFileSync(output, JSON.stringify(file, null, 2) + '\n', { flag: 'wx' });
  for (const line of formatSummary(file)) say(line);
  say(`Report written to: ${output}`);
  return 0;
}

if (require.main === module) {
  void runHoldoutReport(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      console.error(`[holdout-report] Error: ${(error as Error).message}`);
      process.exitCode = 1;
    });
}
