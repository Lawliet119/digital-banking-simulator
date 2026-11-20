import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import {
  engineFingerprint,
  matchRuleSetRows,
  verifyCapture,
  verifyEngine,
  verifyFreeze,
  type FreezeManifest,
  type ReadText,
  type RuleSetRow,
} from '../modules/risk/evaluation/freeze';

const MANIFEST = 'src/modules/risk/evaluation/configs/freeze-manifest.json';
const USAGE =
  'Usage: freeze-verify [--capture <holdout-capture.jsonl> [--input <holdout.csv>]] [--database-url <postgres url>]  ' +
  '(run from backend/; checks the frozen rule configuration, DBS-168)';

export interface FreezeVerifyDeps {
  readonly backendRoot?: string;
  /** Test seam: check this manifest instead of the one in the repository. */
  readonly manifest?: FreezeManifest;
  readonly log?: (line: string) => void;
  readonly fetchRows?: (databaseUrl: string) => Promise<RuleSetRow[]>;
}

async function fetchRuleSetRows(databaseUrl: string): Promise<RuleSetRow[]> {
  const source = await new DataSource({ type: 'postgres', url: databaseUrl }).initialize();
  try {
    return await source.query<RuleSetRow[]>(
      'SELECT version, config FROM risk_rule_sets ORDER BY version',
    );
  } finally {
    await source.destroy();
  }
}

interface Args {
  capture?: string;
  input?: string;
  databaseUrl?: string;
}

function parseArgs(args: readonly string[]): Args {
  const parsed: Args = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--capture' || arg === '--input' || arg === '--database-url') {
      if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--capture') parsed.capture = next;
      else if (arg === '--input') parsed.input = next;
      else parsed.databaseUrl = next;
      i++;
    } else throw new Error(`Unknown option '${arg}'`);
  }
  if (parsed.input !== undefined && parsed.capture === undefined) {
    throw new Error('--input is only used with --capture');
  }
  return parsed;
}

/** Exit code: 0 everything matches, 1 a frozen value differs, 2 bad usage. */
export async function runFreezeVerify(
  args: readonly string[],
  deps: FreezeVerifyDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const root = deps.backendRoot ?? resolve(__dirname, '..', '..');
  let options: Args;
  try {
    options = parseArgs(args);
  } catch (error) {
    log(`[freeze-verify] Error: ${(error as Error).message}. ${USAGE}`);
    return 2;
  }
  const read: ReadText = path => {
    try {
      return readFileSync(resolve(root, path), 'utf8');
    } catch {
      return undefined;
    }
  };
  const manifestText = deps.manifest ? '' : read(MANIFEST);
  if (manifestText === undefined) {
    log(`[freeze-verify] Error: ${MANIFEST} is missing`);
    return 1;
  }
  const manifest = deps.manifest ?? (JSON.parse(manifestText) as FreezeManifest);
  let failed = false;
  const section = (name: string, problems: readonly string[], detail = ''): void => {
    if (problems.length === 0) log(`[freeze-verify] OK    ${name}${detail ? `: ${detail}` : ''}`);
    else {
      failed = true;
      for (const problem of problems) log(`[freeze-verify] FAIL  ${name}: ${problem}`);
    }
  };

  const { rule_only: ruleOnly, rules_with_external_ai: withAi } = manifest.modes;
  section(
    'configuration, rubric and seed files',
    verifyFreeze(manifest, read),
    `rule_only label ${ruleOnly.evaluationVersion} sha256 ${ruleOnly.configSha256}; ` +
      `rules_with_external_ai label ${withAi.evaluationVersion} sha256 ${withAi.configSha256}, ` +
      `provider ${withAi.ai.provider}, model ${withAi.ai.model}, rubricSha256 ${withAi.ai.rubricSha256}, ` +
      `ai.threshold ${withAi.ai.threshold}, ai.weight ${withAi.ai.weight}`,
  );
  section(
    'engine files',
    verifyEngine(manifest, read),
    `${Object.keys(manifest.engine.files).length} files unchanged since ${manifest.frozenOn}, fingerprint ${engineFingerprint(manifest)}`,
  );
  section(
    'amendments',
    [],
    manifest.amendments.length === 0
      ? 'none since the freeze'
      : manifest.amendments.map(a => `${a.id} (${a.date})`).join(', '),
  );

  if (options.capture !== undefined) {
    let text: string | undefined;
    try {
      text = readFileSync(resolve(process.cwd(), options.capture), 'utf8');
    } catch {
      section('capture', [`cannot read ${options.capture}`]);
    }
    let csv: string | undefined;
    if (text !== undefined && options.input !== undefined) {
      try {
        csv = readFileSync(resolve(process.cwd(), options.input), 'utf8');
      } catch {
        section('capture', [`cannot read ${options.input}`]);
        text = undefined;
      }
    }
    if (text !== undefined) {
      const check = verifyCapture(manifest, text, csv);
      section(
        'capture',
        check.problems,
        `${check.lines} lines, status ${JSON.stringify(check.statusCounts)}, ` +
          `responseModel ${check.responseModels.join(',') || '(none)'} (record it in the holdout report), ` +
          (csv === undefined
            ? 'sample NOT checked (pass --input <holdout.csv> to check it)'
            : 'sample equals the frozen sample'),
      );
      for (const warning of check.warnings) log(`[freeze-verify] WARN  capture: ${warning}`);
    }
  }

  if (options.databaseUrl !== undefined) {
    try {
      const rows = await (deps.fetchRows ?? fetchRuleSetRows)(options.databaseUrl);
      const match = matchRuleSetRows(manifest, read, rows);
      const created = (version: number | null): string =>
        version === null ? 'not created in risk_rule_sets' : `created as version ${version}`;
      section(
        'risk_rule_sets',
        match.problems,
        `version ${manifest.dbSeed.version} equals ${manifest.dbSeed.configFile}; ` +
          `rule_only ${created(match.created.rule_only)}; ` +
          `rules_with_external_ai ${created(match.created.rules_with_external_ai)}; ` +
          `active version ${match.activeVersion ?? 'none'} (${match.activeMode ?? 'n/a'})`,
      );
    } catch (error) {
      section('risk_rule_sets', [`cannot read the table: ${(error as Error).message}`]);
    }
  }

  log(
    failed
      ? '[freeze-verify] RESULT: NOT FROZEN AS RECORDED'
      : '[freeze-verify] RESULT: FROZEN AS RECORDED',
  );
  return failed ? 1 : 0;
}

if (require.main === module) {
  void runFreezeVerify(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
