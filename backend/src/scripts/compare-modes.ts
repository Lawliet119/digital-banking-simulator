import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCaptureLines } from '../modules/risk/evaluation/capture-ai';
import {
  compareModes,
  type ComparisonReport,
  type ModeResult,
} from '../modules/risk/evaluation/compare-modes';

const USAGE =
  'Usage: compare-modes --input <tune.csv> --capture <capture.jsonl> --config <rule-set.json> ' +
  '--seed <text> [--config-version <n>] [--iterations <n>] [--output <report.json>]';

interface Args {
  input?: string;
  capture?: string;
  config?: string;
  seed?: string;
  configVersion: number;
  iterations?: number;
  output?: string;
}

function parseArgs(args: string[]): Args {
  const parsed: Args = { configVersion: 1 };
  const value = (i: number, name: string): string => {
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${name}`);
    return next;
  };
  const positive = (text: string, name: string): number => {
    if (!/^[1-9]\d*$/.test(text)) throw new Error(`Invalid ${name}: positive integer`);
    return Number(text);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input') parsed.input = value(i++, arg);
    else if (arg === '--capture') parsed.capture = value(i++, arg);
    else if (arg === '--config') parsed.config = value(i++, arg);
    else if (arg === '--seed') parsed.seed = value(i++, arg);
    else if (arg === '--output') parsed.output = value(i++, arg);
    else if (arg === '--config-version') parsed.configVersion = positive(value(i++, arg), arg);
    else if (arg === '--iterations') parsed.iterations = positive(value(i++, arg), arg);
    else throw new Error(`Unknown option '${arg}'. ${USAGE}`);
  }
  for (const [name, set] of [
    ['--input', parsed.input],
    ['--capture', parsed.capture],
    ['--config', parsed.config],
    ['--seed', parsed.seed],
  ] as const) {
    if (!set) throw new Error(`Missing required option: ${name}. ${USAGE}`);
  }
  return parsed;
}

const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;

function modeLine(label: string, r: ModeResult): string {
  const m = r.metrics;
  return (
    `${label}: precision=${pct(m.precision)} recall=${pct(m.recall)} F1=${pct(m.f1)} ` +
    `alerts/1000=${m.alertsPer1000} (sample: ${r.sampleFlagged} flagged, ${r.sampleFraudCaught} fraud caught)`
  );
}

export function formatComparison(report: ComparisonReport): string[] {
  const s = report.sample;
  const lines = [
    `sample ${s.transfers} transfers (${s.fraud} fraud); train ${s.trainRows} rows / ${s.trainCustomers} customers, ` +
      `validation ${s.validationRows} rows / ${s.validationCustomers} customers`,
    `AI parameters: ${report.grid.length} threshold x weight pairs tried on train (a trial count to report, ADR-14)`,
    `AI parameters chosen on train: threshold ${report.chosen.threshold}, weight ${report.chosen.weight}` +
      `${report.chosen.feasible ? '' : ' (NO grid point fits the alert budget on train)'}`,
    `provenance: models ${report.provenance.models.join(',') || '(none)'}, rubricSha256 ${report.provenance.rubricSha256.join(',') || '(none)'}, ` +
      `status ${JSON.stringify(report.provenance.statusCounts)}`,
    'validation (weighted to the whole file):',
    `  ${modeLine('B0', report.validation.b0)}`,
    `  ${modeLine('B1', report.validation.b1)}`,
    `  ${modeLine('B2', report.validation.b2)}`,
    `  AI extra flags (B2 not B0): right ${report.aiExtraFlags.rightSample}, wrong ${report.aiExtraFlags.wrongSample} ` +
      `(weighted right ${report.aiExtraFlags.rightWeighted}, wrong ${report.aiExtraFlags.wrongWeighted})`,
    `  recall gain B2-B0: overall ${(report.recallGain.overall.point * 100).toFixed(2)} pts ` +
      `[${(report.recallGain.overall.low * 100).toFixed(2)}, ${(report.recallGain.overall.high * 100).toFixed(2)}], ` +
      `in-scope ${(report.recallGain.inScope.point * 100).toFixed(2)} pts ` +
      `[${(report.recallGain.inScope.low * 100).toFixed(2)}, ${(report.recallGain.inScope.high * 100).toFixed(2)}] ` +
      `(${report.recallGain.iterations} bootstrap draws by customer)`,
    'recall by scenario (validation, B0 / B1 / B2):',
  ];
  for (const row of report.byScenario) {
    lines.push(
      `  ${row.scenario}${row.inScope ? '' : ' (out of scope)'} n=${row.fraud}: ` +
        `${pct(row.b0)} / ${pct(row.b1)} / ${pct(row.b2)}`,
    );
  }
  lines.push(
    `cost: ${report.cost.calls} calls, ${report.cost.inputTokens} input tokens, ~$${report.cost.usd} ` +
      `(~$${report.cost.usdPer1000Transfers} per 1000 TRANSFER); call latency p50 ${report.cost.callLatencyMs.p50} ms, ` +
      `p95 ${report.cost.callLatencyMs.p95} ms`,
  );
  lines.push(`gate: ${report.gate.verdict}`);
  for (const item of report.gate.items) {
    lines.push(`  [${item.status}] ${item.name}: ${item.detail}`);
  }
  return lines;
}

export async function runCompareModes(args: string[]): Promise<ComparisonReport> {
  const options = parseArgs(args);
  const report = await compareModes({
    csvText: readFileSync(resolve(process.cwd(), options.input!), 'utf8'),
    config: JSON.parse(readFileSync(resolve(process.cwd(), options.config!), 'utf8')) as unknown,
    configVersion: options.configVersion,
    capture: parseCaptureLines(readFileSync(resolve(process.cwd(), options.capture!), 'utf8')),
    seed: options.seed!,
    bootstrapIterations: options.iterations,
  });
  for (const line of formatComparison(report)) console.log(`[compare-modes] ${line}`);
  if (options.output) {
    const path = resolve(process.cwd(), options.output);
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
    console.log(`[compare-modes] Report written to: ${path}`);
  }
  return report;
}

if (require.main === module) {
  void runCompareModes(process.argv.slice(2)).catch(error => {
    console.error(`[compare-modes] Error: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
