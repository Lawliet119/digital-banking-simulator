import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SplitPart } from '../modules/risk/evaluation/customer-split';
import {
  evaluateRules,
  parseCapture,
  type EvaluationReport,
  type Metrics,
} from '../modules/risk/evaluation/evaluate-rules';

const USAGE =
  'Usage: evaluate-rules --input <tune.csv> --config <rule-set.json> [--config-version <n>] ' +
  '[--seed <text> [--part train|validation]] [--ai-capture <file.jsonl> [--restrict-to-capture]] [--output <report.json>]';

interface Args {
  input?: string;
  config?: string;
  configVersion: number;
  seed?: string;
  part?: SplitPart;
  aiCapture?: string;
  restrictToCapture: boolean;
  output?: string;
}

function parseArgs(args: string[]): Args {
  const parsed: Args = { configVersion: 1, restrictToCapture: false };
  const value = (i: number, name: string): string => {
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${name}`);
    return next;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--restrict-to-capture') parsed.restrictToCapture = true;
    else if (arg === '--input') parsed.input = value(i++, arg);
    else if (arg === '--config') parsed.config = value(i++, arg);
    else if (arg === '--seed') parsed.seed = value(i++, arg);
    else if (arg === '--part') {
      const text = value(i++, arg);
      if (text !== 'train' && text !== 'validation')
        throw new Error('Invalid --part: train or validation');
      parsed.part = text;
    } else if (arg === '--ai-capture') parsed.aiCapture = value(i++, arg);
    else if (arg === '--output') parsed.output = value(i++, arg);
    else if (arg === '--config-version') {
      const text = value(i++, arg);
      if (!/^[1-9]\d*$/.test(text)) throw new Error('Invalid --config-version: positive integer');
      parsed.configVersion = Number(text);
    } else throw new Error(`Unknown option '${arg}'. ${USAGE}`);
  }
  if (!parsed.input) throw new Error(`Missing required option: --input. ${USAGE}`);
  if (!parsed.config) throw new Error(`Missing required option: --config. ${USAGE}`);
  return parsed;
}

const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;

function metricsLine(label: string, m: Metrics): string {
  return (
    `${label}: TP=${m.tp} FP=${m.fp} FN=${m.fn} TN=${m.tn}  precision=${pct(m.precision)} ` +
    `recall=${pct(m.recall)} F1=${pct(m.f1)} FPR=${pct(m.falsePositiveRate)} ` +
    `alerts/1000=${m.alertsPer1000}`
  );
}

export function formatReport(report: EvaluationReport): string[] {
  const lines = [
    `config version ${report.configVersion}, mode ${report.mode}, ` +
      `thresholds medium=${report.thresholds.medium} high=${report.thresholds.high}, ` +
      `seed ${report.seed ?? '(not given)'}, part ${report.part ?? 'whole file'}`,
    `csv sha256 ${report.csvSha256}`,
    `${report.transactions} transfers, ${report.frauds} fraud`,
  ];
  if (report.ai) {
    lines.push(
      `ai: model ${report.ai.model}, threshold ${report.ai.threshold}, weight ${report.ai.weight}, ` +
        `rubricSha256 ${report.ai.rubricSha256.join(',') || '(none)'}, ` +
        `status ${JSON.stringify(report.ai.statusCounts)}`,
    );
  }
  if (report.baseline) lines.push(metricsLine('B0 (rules only, same rows)', report.baseline));
  lines.push(metricsLine(report.ai ? 'B2 (rules + AI)' : 'B0 (rules only)', report.metrics));
  const inScope = report.inScopeRecall;
  lines.push(
    `recall in-scope (5 scenarios): ${inScope.caught}/${inScope.fraud} = ${pct(inScope.recall)}`,
  );
  for (const [name, s] of Object.entries(report.byScenario)) {
    lines.push(`  ${name}: ${s.caught}/${s.fraud} = ${pct(s.recall)}`);
  }
  for (const [name, h] of Object.entries(report.hardNegatives)) {
    lines.push(`  hard negative ${name}: flagged ${h.flagged}/${h.rows}`);
  }
  return lines;
}

export async function runEvaluateRules(args: string[]): Promise<EvaluationReport> {
  const options = parseArgs(args);
  const csvText = readFileSync(resolve(process.cwd(), options.input!), 'utf8');
  const config: unknown = JSON.parse(readFileSync(resolve(process.cwd(), options.config!), 'utf8'));
  const capture = options.aiCapture
    ? parseCapture(readFileSync(resolve(process.cwd(), options.aiCapture), 'utf8'))
    : undefined;
  const report = await evaluateRules({
    csvText,
    config,
    configVersion: options.configVersion,
    seed: options.seed,
    part: options.part,
    capture,
    restrictToCapture: options.restrictToCapture,
  });
  for (const line of formatReport(report)) console.log(`[evaluate-rules] ${line}`);
  if (options.output) {
    writeFileSync(resolve(process.cwd(), options.output), JSON.stringify(report, null, 2) + '\n');
    console.log(`[evaluate-rules] Report written to: ${resolve(process.cwd(), options.output)}`);
  }
  return report;
}

if (require.main === module) {
  void runEvaluateRules(process.argv.slice(2)).catch(error => {
    console.error(`[evaluate-rules] Error: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
