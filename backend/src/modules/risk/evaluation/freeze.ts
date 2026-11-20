import { createHash } from 'node:crypto';
import { parseRuleSet } from '../config/rule-set';
import { parseCaptureLines, selectSample } from './capture-ai';

/**
 * Freeze of the rule configuration before the holdout run (DBS-168). `configs/freeze-manifest.json`
 * lists what is frozen and its sha256; this module checks that the repository still matches it.
 * Pure: file access goes through a reader, so tests can swap one file for an edited copy.
 *
 * Record for people: docs/components/risk/09-freeze-rule-config.md.
 */

export type FreezeMode = 'rule_only' | 'rules_with_external_ai';

export interface FreezeAi {
  readonly provider: string;
  readonly model: string;
  readonly rubricFile: string;
  /** sha256 of the rubric file (line endings normalised): differs from `rubricSha256` by the final newline. */
  readonly rubricFileSha256: string;
  /** sha256 of the trimmed rubric text: the value the OpenAI adapter writes into every capture line. */
  readonly rubricSha256: string;
  /** `responseModel` values seen in the tune capture; a holdout capture that differs is reported as a warning. */
  readonly responseModels: readonly string[];
  readonly threshold: number;
  readonly weight: number;
  readonly maxAdmissionDelayMs: number;
  readonly requestTimeoutMs: number;
}

export interface FreezeManifest {
  readonly freezeId: string;
  readonly frozenOn: string;
  readonly baseCommit: string;
  readonly evaluationSeed: string;
  readonly tune: {
    readonly csvSha256: string;
    readonly transactions: number;
    readonly aiCaptureSha256: string;
  };
  readonly modes: {
    readonly rule_only: {
      readonly evaluationVersion: number;
      readonly configFile: string;
      readonly configSha256: string;
    };
    readonly rules_with_external_ai: {
      readonly evaluationVersion: number;
      readonly configFile: string;
      readonly configSha256: string;
      readonly ai: FreezeAi;
      readonly capture: {
        readonly seed: string;
        readonly normalSample: number;
        readonly timeoutMs: number;
      };
    };
  };
  readonly dbSeed: {
    readonly version: number;
    readonly configFile: string;
    readonly configSha256: string;
  };
  readonly engine: { readonly files: Readonly<Record<string, string>> };
  /**
   * One entry per change made after the freeze. `expected` holds the values the repository must have
   * after that change, so the pinned values of the spec move only together with an entry here.
   */
  readonly amendments: readonly {
    readonly id: string;
    readonly date: string;
    readonly expected: {
      readonly ruleOnly: string;
      readonly withAi: string;
      readonly dbSeed: string;
      readonly rubricFile: string;
      readonly rubric: string;
      readonly engine: string;
    };
  }[];
}

/** Reads a text file by path relative to `backend/`; `undefined` when it does not exist. */
export type ReadText = (path: string) => string | undefined;

export const normalizeText = (text: string): string => text.replace(/\r\n/g, '\n');
export const sha256Text = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
/** Hash of a file as the repository stores it (`eol=lf`), whatever the checkout's line endings. */
export const fileSha256 = (text: string): string => sha256Text(normalizeText(text));

/** JSON with sorted keys, so two documents with the same content compare equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJson(read: ReadText, path: string): unknown {
  const text = read(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function checkHash(read: ReadText, path: string, expected: string, problems: string[]): void {
  const text = read(path);
  if (text === undefined) {
    problems.push(`${path}: file is missing`);
    return;
  }
  const actual = fileSha256(text);
  if (actual !== expected) {
    problems.push(`${path}: sha256 is ${actual}, the manifest freezes ${expected}`);
  }
}

/** Everything about the frozen configuration files, the rubric and the seed. Empty list = frozen as recorded. */
export function verifyFreeze(manifest: FreezeManifest, read: ReadText): string[] {
  const problems: string[] = [];
  const ruleOnly = manifest.modes.rule_only;
  const withAi = manifest.modes.rules_with_external_ai;
  const ai = withAi.ai;

  checkHash(read, ruleOnly.configFile, ruleOnly.configSha256, problems);
  checkHash(read, withAi.configFile, withAi.configSha256, problems);
  checkHash(read, ai.rubricFile, ai.rubricFileSha256, problems);
  checkHash(read, manifest.dbSeed.configFile, manifest.dbSeed.configSha256, problems);

  const rubricFileText = read(ai.rubricFile);
  if (rubricFileText?.includes('\r')) {
    // capture-ai only trims the file, so a CRLF checkout would send (and hash) another rubric.
    problems.push(
      `${ai.rubricFile}: contains carriage returns, capture-ai would send another rubric`,
    );
  }

  const ruleOnlyJson = readJson(read, ruleOnly.configFile);
  if (ruleOnlyJson !== undefined) {
    try {
      const parsed = parseRuleSet(ruleOnly.evaluationVersion, ruleOnlyJson);
      if (parsed.mode !== 'rule_only' || parsed.ai !== undefined) {
        problems.push(`${ruleOnly.configFile}: must be mode rule_only without an ai block`);
      }
    } catch (error) {
      problems.push(`${ruleOnly.configFile}: invalid rule set (${(error as Error).message})`);
    }
  }

  const aiJson = readJson(read, withAi.configFile);
  if (aiJson !== undefined) {
    try {
      const parsed = parseRuleSet(withAi.evaluationVersion, aiJson);
      const frozen = parsed.ai;
      if (parsed.mode !== 'rules_with_external_ai' || parsed.aiConfigInvalid || !frozen) {
        problems.push(
          `${withAi.configFile}: must be mode rules_with_external_ai with a valid ai block`,
        );
      } else {
        for (const field of [
          'provider',
          'model',
          'threshold',
          'weight',
          'maxAdmissionDelayMs',
          'requestTimeoutMs',
        ] as const) {
          if (frozen[field] !== ai[field]) {
            problems.push(
              `${withAi.configFile}: ai.${field} is ${String(frozen[field])}, the manifest freezes ${String(ai[field])}`,
            );
          }
        }
        const rubricText = read(ai.rubricFile);
        if (rubricText !== undefined && frozen.rubric !== normalizeText(rubricText).trim()) {
          problems.push(
            `${withAi.configFile}: ai.rubric differs from the trimmed ${ai.rubricFile}`,
          );
        }
        const actualRubricSha = sha256Text(frozen.rubric);
        if (actualRubricSha !== ai.rubricSha256) {
          problems.push(
            `${withAi.configFile}: sha256 of ai.rubric is ${actualRubricSha}, the manifest freezes rubricSha256 ${ai.rubricSha256}`,
          );
        }
      }
    } catch (error) {
      problems.push(`${withAi.configFile}: invalid rule set (${(error as Error).message})`);
    }
    if (ruleOnlyJson !== undefined && typeof aiJson === 'object' && aiJson !== null) {
      const without = (value: unknown, keys: readonly string[]): unknown =>
        Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(([key]) => !keys.includes(key)),
        );
      if (
        canonicalJson(without(aiJson, ['mode', 'ai'])) !==
        canonicalJson(without(ruleOnlyJson, ['mode']))
      ) {
        problems.push(
          `${withAi.configFile}: apart from mode and ai it must equal ${ruleOnly.configFile}`,
        );
      }
    }
  }
  return problems;
}

/** The code that decides a holdout result (rules, scoring, offline features, CSV reading, measuring). */
export function verifyEngine(manifest: FreezeManifest, read: ReadText): string[] {
  const problems: string[] = [];
  for (const [path, expected] of Object.entries(manifest.engine.files)) {
    checkHash(read, path, expected, problems);
  }
  return problems;
}

/** One hash over every engine file name and hash: short enough for the freeze announcement. */
export function engineFingerprint(manifest: FreezeManifest): string {
  const lines = Object.entries(manifest.engine.files)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, hash]) => `${path} ${hash}\n`);
  return sha256Text(lines.join(''));
}

export interface CaptureCheck {
  readonly problems: string[];
  /** Not a failure, but to be recorded in the holdout report. */
  readonly warnings: string[];
  readonly lines: number;
  readonly responseModels: string[];
  readonly statusCounts: Record<string, number>;
}

/**
 * A holdout capture must have been made with the frozen rubric, model and provider. With the CSV it
 * was made from (`csvText`) it must also be exactly the frozen sample: same seed and `normalSample`,
 * every transfer present, the same sampling weights (a partial or differently sampled capture would
 * make `--restrict-to-capture` measure a subset).
 */
export function verifyCapture(
  manifest: FreezeManifest,
  captureText: string,
  csvText?: string,
): CaptureCheck {
  const frozen = manifest.modes.rules_with_external_ai.ai;
  const problems: string[] = [];
  const warnings: string[] = [];
  const responseModels = new Set<string>();
  const statusCounts: Record<string, number> = {};
  let lines = 0;
  let withRubric = 0;
  try {
    const capture = parseCaptureLines(captureText);
    lines = capture.size;
    const wrong = { rubric: 0, model: 0, provider: 0 };
    for (const { assessment } of capture.values()) {
      statusCounts[assessment.status] = (statusCounts[assessment.status] ?? 0) + 1;
      if (assessment.rubricSha256) {
        withRubric += 1;
        if (assessment.rubricSha256 !== frozen.rubricSha256) wrong.rubric += 1;
      }
      if (assessment.requestedModel && assessment.requestedModel !== frozen.model) wrong.model += 1;
      if (assessment.provider && assessment.provider !== frozen.provider) wrong.provider += 1;
      if (assessment.responseModel) responseModels.add(assessment.responseModel);
    }
    if (wrong.rubric > 0) {
      problems.push(
        `${wrong.rubric} capture line(s) carry a rubricSha256 other than ${frozen.rubricSha256}`,
      );
    }
    if (wrong.model > 0) {
      problems.push(`${wrong.model} capture line(s) requested a model other than ${frozen.model}`);
    }
    if (wrong.provider > 0) {
      problems.push(
        `${wrong.provider} capture line(s) used a provider other than ${frozen.provider}`,
      );
    }
    if (withRubric === 0) problems.push('no capture line carries a rubricSha256');
    const unexpected = [...responseModels].filter(model => !frozen.responseModels.includes(model));
    if (unexpected.length > 0) {
      warnings.push(
        `responseModel ${unexpected.join(',')} differs from the tune capture (${frozen.responseModels.join(',')}): the alias may point to another snapshot, record it in the holdout report`,
      );
    }
    if (csvText !== undefined) {
      const { seed, normalSample } = manifest.modes.rules_with_external_ai.capture;
      const sample = selectSample(csvText, seed, normalSample);
      const missing = sample.txIds.filter(id => !capture.has(id)).length;
      const extra = [...capture.keys()].filter(id => !sample.weights.has(id)).length;
      const reweighted = [...capture.values()].filter(line => {
        const expected = sample.weights.get(line.txId);
        return expected !== undefined && Math.abs(expected - line.sampleWeight) > 0.01;
      }).length;
      if (missing > 0)
        problems.push(`${missing} transfer(s) of the frozen sample are not in the capture`);
      if (extra > 0) problems.push(`${extra} capture line(s) are not in the frozen sample`);
      if (reweighted > 0) {
        problems.push(
          `${reweighted} capture line(s) have a sampling weight other than the frozen sample's`,
        );
      }
    }
  } catch (error) {
    problems.push(`capture is not readable: ${(error as Error).message}`);
  }
  return { problems, warnings, lines, responseModels: [...responseModels].sort(), statusCounts };
}

export interface RuleSetRow {
  readonly version: number;
  readonly config: unknown;
}

export interface RuleSetMatch {
  readonly problems: string[];
  /** Lowest database version whose `config` equals the frozen file, or null when none was created. */
  readonly created: Record<FreezeMode, number | null>;
  readonly activeVersion: number | null;
  readonly activeMode: string | null;
}

/** Compares `risk_rule_sets` with the repository: the seed must be v1, frozen versions are located. */
export function matchRuleSetRows(
  manifest: FreezeManifest,
  read: ReadText,
  rows: readonly RuleSetRow[],
): RuleSetMatch {
  const problems: string[] = [];
  const sorted = [...rows].sort((a, b) => a.version - b.version);

  const seedJson = readJson(read, manifest.dbSeed.configFile);
  const seedRow = sorted.find(row => row.version === manifest.dbSeed.version);
  if (!seedRow) {
    problems.push(`risk_rule_sets has no version ${manifest.dbSeed.version}`);
  } else if (seedJson === undefined || canonicalJson(seedRow.config) !== canonicalJson(seedJson)) {
    problems.push(
      `risk_rule_sets version ${manifest.dbSeed.version} differs from ${manifest.dbSeed.configFile}`,
    );
  }

  const locate = (file: string): number | null => {
    const json = readJson(read, file);
    if (json === undefined) return null;
    const wanted = canonicalJson(json);
    return sorted.find(row => canonicalJson(row.config) === wanted)?.version ?? null;
  };
  const created: Record<FreezeMode, number | null> = {
    rule_only: locate(manifest.modes.rule_only.configFile),
    rules_with_external_ai: locate(manifest.modes.rules_with_external_ai.configFile),
  };

  const latest = sorted[sorted.length - 1];
  const latestMode =
    latest && typeof latest.config === 'object' && latest.config !== null
      ? (latest.config as { mode?: unknown }).mode
      : undefined;
  return {
    problems,
    created,
    activeVersion: latest?.version ?? null,
    activeMode: typeof latestMode === 'string' ? latestMode : latest ? 'rule_only' : null,
  };
}
