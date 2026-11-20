import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectSample } from './capture-ai';
import {
  canonicalJson,
  engineFingerprint,
  fileSha256,
  matchRuleSetRows,
  sha256Text,
  verifyCapture,
  verifyEngine,
  verifyFreeze,
  type FreezeManifest,
  type ReadText,
} from './freeze';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

const BACKEND = resolve(__dirname, '..', '..', '..', '..');
const REPO = resolve(BACKEND, '..');
const MANIFEST_PATH = 'src/modules/risk/evaluation/configs/freeze-manifest.json';

/** Values frozen on 2026-11-21 (DBS-168). Changing the manifest without an `amendments` entry fails. */
const FROZEN = {
  ruleOnly: 'c9da84a345f7da5f50f18059d85e14ee7ed5a5e688d3fc88faed98d39ba655c8',
  withAi: '426b97fb6090b0b23c1ef261f4a677962b0d3c5290613a13208a214ab9819dd9',
  dbSeed: '876bdd9750a0067039dc5af59d318c7767f535e7dea8ed30ecbba886ec127aa8',
  rubricFile: '0640e98b4359bfb5dba55c4ee1ab553c0a321e9298e94a79c7ee77a9c74680b5',
  rubric: '96e0b08fadcbd7ec2fdadd71f59569e02b7273db453d657acd44ade7c5f9a0ff',
  engine: 'b62a0ab2a528e34301df4cd91ccaf5aec6d1b8efc8597be1d305008d760e5d0f',
  labels: { ruleOnly: 4, withAi: 5 },
  capture: { seed: 'dbs-split-v1', normalSample: 1000000, timeoutMs: 20000 },
  responseModels: ['gpt-6-luna'],
};

const realRead: ReadText = path => {
  try {
    return readFileSync(resolve(BACKEND, path), 'utf8');
  } catch {
    return undefined;
  }
};
const manifest = (): Mutable<FreezeManifest> =>
  JSON.parse(realRead(MANIFEST_PATH)!) as Mutable<FreezeManifest>;
const override =
  (path: string, change: (text: string) => string | undefined): ReadText =>
  p => {
    const text = realRead(p);
    return p === path && text !== undefined ? change(text) : text;
  };

/** The manifest and reader for a file legitimately edited and re-hashed: only the structural checks are left. */
function amended(
  which: 'rule_only' | 'rules_with_external_ai',
  change: (text: string) => string,
): { m: Mutable<FreezeManifest>; read: ReadText } {
  const m = manifest();
  const entry = m.modes[which];
  const edited = change(realRead(entry.configFile)!);
  entry.configSha256 = fileSha256(edited);
  return { m, read: override(entry.configFile, () => edited) };
}

describe('freeze of the rule configuration (DBS-168)', () => {
  it('TC-168-01 the repository matches its manifest, and the manifest its pinned values', () => {
    const m = manifest();
    expect(verifyFreeze(m, realRead)).toEqual([]);
    // After an amendment the values to expect are the ones that amendment recorded.
    const expected = m.amendments[m.amendments.length - 1]?.expected ?? FROZEN;
    expect(m.modes.rule_only.configSha256).toBe(expected.ruleOnly);
    expect(m.modes.rules_with_external_ai.configSha256).toBe(expected.withAi);
    expect(m.dbSeed.configSha256).toBe(expected.dbSeed);
    expect(m.modes.rules_with_external_ai.ai.rubricFileSha256).toBe(expected.rubricFile);
    expect(m.modes.rules_with_external_ai.ai.rubricSha256).toBe(expected.rubric);
    expect(engineFingerprint(m)).toBe(expected.engine);
    if (m.amendments.length === 0) {
      expect(m.modes.rule_only.evaluationVersion).toBe(FROZEN.labels.ruleOnly);
      expect(m.modes.rules_with_external_ai.evaluationVersion).toBe(FROZEN.labels.withAi);
      expect(m.modes.rules_with_external_ai.capture).toEqual(FROZEN.capture);
      expect(m.modes.rules_with_external_ai.ai.responseModels).toEqual(FROZEN.responseModels);
    }
  });

  it('TC-168-02 changing one character of a frozen file is reported with both hashes', () => {
    const m = manifest();
    const file = m.modes.rule_only.configFile;
    const problems = verifyFreeze(
      m,
      override(file, text => text.replace('"maxTransfers": 2', '"maxTransfers": 3')),
    );
    expect(problems.some(p => p.includes(file) && p.includes(m.modes.rule_only.configSha256))).toBe(
      true,
    );
  });

  it('TC-168-03 a CRLF checkout of the same content still matches', () => {
    const file = manifest().modes.rule_only.configFile;
    expect(
      verifyFreeze(
        manifest(),
        override(file, t => t.replace(/\n/g, '\r\n')),
      ),
    ).toEqual([]);
    expect(fileSha256('a\r\nb\r\n')).toBe(fileSha256('a\nb\n'));
  });

  it('TC-168-04 the AI configuration is v4 plus a valid ai block with the frozen values', () => {
    const m = manifest();
    const frozen = m.modes.rules_with_external_ai;
    const config = JSON.parse(realRead(frozen.configFile)!) as Record<string, unknown>;
    const base = JSON.parse(realRead(m.modes.rule_only.configFile)!) as Record<string, unknown>;
    const { mode: aiMode, ai: aiBlock, ...aiRest } = config;
    const { mode: baseMode, ...baseRest } = base;
    expect(aiMode).toBe('rules_with_external_ai');
    expect(baseMode).toBe('rule_only');
    expect(aiBlock).toMatchObject({
      provider: frozen.ai.provider,
      model: frozen.ai.model,
      threshold: frozen.ai.threshold,
      weight: frozen.ai.weight,
    });
    expect(canonicalJson(aiRest)).toBe(canonicalJson(baseRest));
  });

  it('TC-168-05 a changed rubric or a wrong rubricSha256 is reported', () => {
    const edited = amended('rules_with_external_ai', t =>
      t.replace('graded probability', 'graded likelihood'),
    );
    const problems = verifyFreeze(edited.m, edited.read);
    expect(problems.some(p => p.includes('ai.rubric differs from the trimmed'))).toBe(true);
    expect(problems.some(p => p.includes('rubricSha256'))).toBe(true);

    const wrong = manifest();
    wrong.modes.rules_with_external_ai.ai.rubricSha256 = '0'.repeat(64);
    expect(verifyFreeze(wrong, realRead).some(p => p.includes('rubricSha256'))).toBe(true);
  });

  it('TC-168-06 rubricSha256 is the hash of the trimmed rubric, not of the file with its newline', () => {
    const m = manifest();
    const raw = realRead(m.modes.rules_with_external_ai.ai.rubricFile)!;
    const trimmed = raw.replace(/\r\n/g, '\n').trim();
    expect(sha256Text(trimmed)).toBe(m.modes.rules_with_external_ai.ai.rubricSha256);
    expect(sha256Text(trimmed)).toBe(FROZEN.rubric);
    expect(sha256Text(raw)).not.toBe(sha256Text(trimmed));
    expect(fileSha256(raw)).toBe(m.modes.rules_with_external_ai.ai.rubricFileSha256);
  });

  it('TC-168-07 an invalid ai block is reported by the structural check, not only by the hash', () => {
    const file = manifest().modes.rules_with_external_ai.configFile;
    const edit = (change: (ai: Record<string, unknown>) => void) =>
      amended('rules_with_external_ai', text => {
        const json = JSON.parse(text) as { ai: Record<string, unknown> };
        change(json.ai);
        return JSON.stringify(json, null, 2);
      });

    const noThreshold = edit(ai => delete ai.threshold);
    expect(
      verifyFreeze(noThreshold.m, noThreshold.read).some(p => p.includes('valid ai block')),
    ).toBe(true);
    const fractional = edit(ai => (ai.weight = 40.5));
    expect(
      verifyFreeze(fractional.m, fractional.read).some(p => p.includes('valid ai block')),
    ).toBe(true);
    const retuned = edit(ai => (ai.threshold = 0.7));
    expect(
      verifyFreeze(retuned.m, retuned.read).some(p => p.includes(`${file}: ai.threshold is 0.7`)),
    ).toBe(true);
  });

  it('TC-168-08 the rule_only file keeps its mode, and the AI file stays v4 apart from mode and ai', () => {
    const asAi = amended('rule_only', t =>
      t.replace('"mode": "rule_only"', '"mode": "rules_with_external_ai"'),
    );
    expect(verifyFreeze(asAi.m, asAi.read).some(p => p.includes('must be mode rule_only'))).toBe(
      true,
    );
    const retunedAi = amended('rules_with_external_ai', t =>
      t.replace('"weight": 40,', '"weight": 41,'),
    );
    expect(
      verifyFreeze(retunedAi.m, retunedAi.read).some(p => p.includes('apart from mode and ai')),
    ).toBe(true);
  });

  it('TC-168-09b a rubric file with carriage returns is reported (capture-ai would send another rubric)', () => {
    const m = manifest();
    const file = m.modes.rules_with_external_ai.ai.rubricFile;
    const problems = verifyFreeze(
      m,
      override(file, t => t.replace(/\n/g, '\r\n')),
    );
    expect(problems.some(p => p.includes(file) && p.includes('carriage returns'))).toBe(true);
  });

  it('TC-168-09 a missing file is reported', () => {
    const m = manifest();
    const problems = verifyFreeze(m, p => (p === m.dbSeed.configFile ? undefined : realRead(p)));
    expect(problems.some(p => p.includes(m.dbSeed.configFile) && p.includes('missing'))).toBe(true);
  });

  it('TC-168-10 matchRuleSetRows maps frozen configurations to the versions the database holds', () => {
    const m = manifest();
    const seed = JSON.parse(realRead(m.dbSeed.configFile)!) as unknown;
    const ruleOnly = JSON.parse(realRead(m.modes.rule_only.configFile)!) as unknown;

    const fresh = matchRuleSetRows(m, realRead, [{ version: 1, config: seed }]);
    expect(fresh.problems).toEqual([]);
    expect(fresh.created).toEqual({ rule_only: null, rules_with_external_ai: null });
    expect(fresh.activeVersion).toBe(1);

    const created = matchRuleSetRows(m, realRead, [
      { version: 1, config: seed },
      { version: 2, config: ruleOnly },
    ]);
    expect(created.created.rule_only).toBe(2);
    expect(created.created.rules_with_external_ai).toBeNull();
    expect(created.activeVersion).toBe(2);

    const drifted = matchRuleSetRows(m, realRead, [{ version: 1, config: ruleOnly }]);
    expect(drifted.problems.some(p => /version 1/.test(p))).toBe(true);
    expect(matchRuleSetRows(m, realRead, []).problems.some(p => /version 1/.test(p))).toBe(true);
  });

  it('TC-168-11 a changed or missing engine file is reported by name', () => {
    const files: Record<string, string> = { 'a.ts': 'one', 'b.ts': 'two' };
    const fake = {
      engine: { files: { 'a.ts': fileSha256('one'), 'b.ts': fileSha256('two') } },
    } as unknown as FreezeManifest;
    const read: ReadText = p => files[p];
    expect(verifyEngine(fake, read)).toEqual([]);
    const before = engineFingerprint(fake);
    files['a.ts'] = 'one!';
    expect(verifyEngine(fake, read).some(p => p.startsWith('a.ts'))).toBe(true);
    files['a.ts'] = 'one';
    delete files['b.ts'];
    expect(verifyEngine(fake, read).some(p => p.startsWith('b.ts') && p.includes('missing'))).toBe(
      true,
    );
    expect(engineFingerprint(fake)).toBe(before);
    expect(
      engineFingerprint({
        engine: { files: { 'a.ts': fileSha256('one'), 'b.ts': fileSha256('2') } },
      } as unknown as FreezeManifest),
    ).not.toBe(before);
  });

  describe('verifyCapture', () => {
    const m = manifest();
    const ai = m.modes.rules_with_external_ai.ai;
    const HEADER =
      'tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario';
    const row = (n: number, fraud: 0 | 1, scenario: string): string =>
      [
        `t${n}`,
        `2026-10-01T10:${String(n % 60).padStart(2, '0')}:00.000Z`,
        `from-${n}`,
        `to-${n}`,
        `cust-${n}`,
        `cust-to-${n}`,
        '500000',
        '1000000000',
        '2024-01-01T00:00:00.000Z',
        '2024-01-01T00:00:00.000Z',
        String(fraud),
        scenario,
      ].join(',');
    // Synthetic file: 2 fraud + 20 NORMAL. No relation to any real dataset.
    const CSV = [
      HEADER,
      row(1, 1, 'ATO_DRAIN'),
      row(2, 1, 'SLOW_DRIP'),
      ...Array.from({ length: 20 }, (_, i) => row(10 + i, 0, 'NORMAL')),
    ].join('\n');
    const answered = (txId: string, weight: number, rubric = ai.rubricSha256): string =>
      JSON.stringify({
        txId,
        sampleWeight: weight,
        attempts: 1,
        latencyMs: 300,
        assessment: {
          status: 'SUCCEEDED',
          probability: 0.7,
          provider: ai.provider,
          requestedModel: ai.model,
          responseModel: 'gpt-6-luna',
          requestId: null,
          rubricSha256: rubric,
          inputSha256: null,
          usage: null,
        },
      });
    const unavailable = JSON.stringify({
      txId: 'u1',
      sampleWeight: 1,
      assessment: {
        status: 'UNAVAILABLE',
        probability: null,
        provider: null,
        requestedModel: null,
        responseModel: null,
        rubricSha256: null,
      },
    });
    const frozenSample = selectSample(
      CSV,
      m.modes.rules_with_external_ai.capture.seed,
      m.modes.rules_with_external_ai.capture.normalSample,
    );
    const fullCapture = (): string[] =>
      frozenSample.txIds.map(id => answered(id, frozenSample.weights.get(id)!));

    it('TC-168-12a accepts the frozen rubric and model, ignores a line without rubric', () => {
      const ok = verifyCapture(m, [answered('a', 1), answered('b', 1), unavailable].join('\n'));
      expect(ok.problems).toEqual([]);
      expect(ok.warnings).toEqual([]);
      expect(ok.responseModels).toEqual(['gpt-6-luna']);
    });

    it('TC-168-12b rejects another rubric, model, provider, an unreadable or rubric-less capture', () => {
      const wrongRubric = answered(
        'c',
        1,
        '3d0fd9246b9967727c0bcec8b58677d6246c0c4a9f1f8787df55bd6d503bb6a8',
      );
      expect(
        verifyCapture(m, [answered('a', 1), wrongRubric].join('\n')).problems.some(p =>
          p.includes('rubricSha256 other than'),
        ),
      ).toBe(true);
      const wrongModel = answered('d', 1).replace(
        `"requestedModel":"${ai.model}"`,
        '"requestedModel":"other"',
      );
      expect(verifyCapture(m, wrongModel).problems.some(p => p.includes('requested a model'))).toBe(
        true,
      );
      const wrongProvider = answered('e', 1).replace(
        `"provider":"${ai.provider}"`,
        '"provider":"other"',
      );
      expect(verifyCapture(m, wrongProvider).problems.some(p => p.includes('provider other'))).toBe(
        true,
      );
      expect(verifyCapture(m, unavailable).problems.some(p => p.includes('no capture line'))).toBe(
        true,
      );
      expect(verifyCapture(m, 'not json').problems.some(p => p.includes('not readable'))).toBe(
        true,
      );
    });

    it('TC-168-12c warns, without failing, when the alias answers with another responseModel', () => {
      const moved = answered('a', 1).replace(
        '"responseModel":"gpt-6-luna"',
        '"responseModel":"gpt-6-luna-2027"',
      );
      const check = verifyCapture(m, moved);
      expect(check.problems).toEqual([]);
      expect(check.warnings.some(w => w.includes('gpt-6-luna-2027'))).toBe(true);
    });

    it('TC-168-12d with the CSV, the capture must be exactly the frozen sample', () => {
      expect(verifyCapture(m, fullCapture().join('\n'), CSV).problems).toEqual([]);

      const partial = fullCapture().slice(1);
      expect(
        verifyCapture(m, partial.join('\n'), CSV).problems.some(p =>
          p.includes('not in the capture'),
        ),
      ).toBe(true);

      const smaller = selectSample(CSV, m.modes.rules_with_external_ai.capture.seed, 5);
      const sampledOtherwise = smaller.txIds.map(id => answered(id, smaller.weights.get(id)!));
      const problems = verifyCapture(m, sampledOtherwise.join('\n'), CSV).problems;
      expect(problems.some(p => p.includes('not in the capture'))).toBe(true);
      expect(problems.some(p => p.includes('sampling weight'))).toBe(true);

      const stranger = [...fullCapture(), answered('not-in-csv', 1)];
      expect(
        verifyCapture(m, stranger.join('\n'), CSV).problems.some(p =>
          p.includes('not in the frozen sample'),
        ),
      ).toBe(true);
    });
  });

  it('TC-168-13 the freeze record states each frozen value in the right place', () => {
    const m = manifest();
    const record = readFileSync(
      resolve(REPO, 'docs', 'components', 'risk', '09-freeze-rule-config.md'),
      'utf8',
    );
    const ruleOnly = m.modes.rule_only;
    const withAi = m.modes.rules_with_external_ai;
    const row = (label: string, a: string, b: string): RegExp =>
      new RegExp(`\\|\\s*${label}\\s*\\|\\s*${a}\\s*\\|\\s*${b}\\s*\\|`);
    const esc = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    expect(record).toMatch(
      row(
        'Nhãn đánh giá \\(`--config-version`\\)',
        `\\*\\*${ruleOnly.evaluationVersion}\\*\\*`,
        `\\*\\*${withAi.evaluationVersion}\\*\\*`,
      ),
    );
    expect(record).toMatch(
      row('sha256 file', `\`${ruleOnly.configSha256}\``, `\`${withAi.configSha256}\``),
    );
    expect(record).toMatch(row('`provider`', 'không có khối `ai`', `\`${withAi.ai.provider}\``));
    expect(record).toMatch(row('`rubricSha256`', '', `\`${withAi.ai.rubricSha256}\``));
    expect(record).toMatch(row('`ai.threshold`', '', `\`${esc(String(withAi.ai.threshold))}\``));
    expect(record).toMatch(row('`ai.weight`', '', `\`${withAi.ai.weight}\``));
    const fingerprint = engineFingerprint(m);
    for (const value of [
      m.frozenOn,
      m.baseCommit,
      m.evaluationSeed,
      m.tune.csvSha256,
      m.tune.aiCaptureSha256,
      withAi.ai.model,
      withAi.ai.rubricFileSha256,
      m.dbSeed.configSha256,
      fingerprint,
      // The announcement is the anchor outside the repository: it keeps the values of the freeze.
      `${FROZEN.ruleOnly.slice(0, 8)}…${FROZEN.ruleOnly.slice(-4)}`,
      `${FROZEN.withAi.slice(0, 8)}…${FROZEN.withAi.slice(-4)}`,
      `${FROZEN.engine.slice(0, 8)}…${FROZEN.engine.slice(-4)}`,
      `--normal-sample ${withAi.capture.normalSample}`,
    ]) {
      expect(record).toContain(value);
    }
    for (const amendment of m.amendments) expect(record).toContain(amendment.id);
  });
});
