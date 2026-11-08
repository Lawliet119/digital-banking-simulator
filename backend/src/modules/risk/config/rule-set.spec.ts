import { InvalidRuleSetError, parseRuleSet } from './rule-set';

/** Version 1 as the DBS-58 migration seeds it. */
const SEED_V1 = {
  mode: 'rule_only',
  thresholds: { medium: 40, high: 70 },
  rules: {
    R1: { enabled: true, weight: 30, maxTransfers: 5, windowMinutes: 10 },
    R2: { enabled: true, weight: 25, medianMultiplier: 5, historyDays: 30, minHistory: 5 },
    R3: {
      enabled: true,
      weight: 35,
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
  ml: { enabled: false },
};

const AI = {
  provider: 'openai',
  model: 'gpt-6-luna',
  rubric: 'needs_operator_review',
  threshold: 0.9,
  weight: 40,
  maxAdmissionDelayMs: 2000,
  requestTimeoutMs: 4000,
};
const withAi = (ai: unknown, mode = 'rules_with_external_ai') => ({ ...SEED_V1, mode, ai });
const clone = (): typeof SEED_V1 => JSON.parse(JSON.stringify(SEED_V1)) as typeof SEED_V1;

describe('DBS-110 parseRuleSet', () => {
  it('TC-110-01 maps the seed to rule parameters: weight and switch apart, the rest as thresholds', () => {
    const set = parseRuleSet(1, SEED_V1);
    expect(set.version).toBe(1);
    expect(set.mode).toBe('rule_only');
    expect(set.thresholds).toEqual({ medium: 40, high: 70 });
    expect(set.rules.R1).toEqual({
      enabled: true,
      weight: 30,
      thresholds: { maxTransfers: 5, windowMinutes: 10 },
    });
    expect(set.rules.R2.thresholds).toEqual({
      medianMultiplier: 5,
      historyDays: 30,
      minHistory: 5,
    });
    expect(set.rules.R3.thresholds).toEqual({
      maxAccountAgeHoursExclusive: 24,
      minAmountExclusive: '10000000',
    });
    expect(set.rules.R5.thresholds).toEqual({
      minNewRecipients: 5,
      windowMinutes: 60,
      noveltyDays: 30,
    });
    expect(set.rules.R6.thresholds).toEqual({ minBalancePercent: 90, minBalance: '1000000' });
    expect(set.ai).toBeUndefined();
    expect(set.aiConfigInvalid).toBe(false);
  });

  it('TC-110-01 a missing mode means rule_only, and a disabled rule keeps its weight', () => {
    const raw = clone() as unknown as Record<string, unknown>;
    delete raw.mode;
    (raw.rules as typeof SEED_V1.rules).R4.enabled = false;
    const set = parseRuleSet(2, raw);
    expect(set.mode).toBe('rule_only');
    expect(set.rules.R4).toEqual({
      enabled: false,
      weight: 20,
      thresholds: { reverseWindowMinutes: 60 },
    });
  });

  it('TC-110-02 a valid ai block is kept in rules_with_external_ai', () => {
    const set = parseRuleSet(3, withAi(AI));
    expect(set.mode).toBe('rules_with_external_ai');
    expect(set.ai).toEqual(AI);
    expect(set.aiConfigInvalid).toBe(false);
  });

  it('TC-110-02 an ai block that is broken still gives the rules and flags CONFIG_INVALID, never throws', () => {
    const broken: unknown[] = [
      undefined,
      null,
      'on',
      [],
      { ...AI, threshold: 0 },
      { ...AI, threshold: 1.0001 },
      { ...AI, threshold: Number.NaN },
      { ...AI, threshold: '0.9' },
      { ...AI, weight: -1 },
      { ...AI, weight: 1.5 },
      { ...AI, weight: 2_147_483_647 },
      { ...AI, model: '' },
      { ...AI, model: 'has space' },
      { ...AI, rubric: '' },
      { ...AI, provider: 'other' },
      { ...AI, maxAdmissionDelayMs: 0 },
      { ...AI, requestTimeoutMs: -5 },
      { ...AI, requestTimeoutMs: 2_147_483_648 },
      { ...AI, maxAdmissionDelayMs: undefined },
      { ...AI, requestTimeoutMs: undefined },
    ];
    for (const ai of broken) {
      const set = parseRuleSet(4, withAi(ai));
      expect([JSON.stringify(ai), set.aiConfigInvalid, set.ai]).toEqual([
        JSON.stringify(ai),
        true,
        undefined,
      ]);
      expect(set.rules.R1.weight).toBe(30); // the baseline is intact
    }
  });

  it('TC-110-02 in rule_only an ai block is ignored, even a broken one', () => {
    for (const ai of [AI, { ...AI, threshold: 7 }, 'junk']) {
      const set = parseRuleSet(5, withAi(ai, 'rule_only'));
      expect(set.ai).toBeUndefined();
      expect(set.aiConfigInvalid).toBe(false);
    }
  });

  it('TC-110-02 a mode this build does not know is kept as it is for the scorer to count and fall back', () => {
    expect(parseRuleSet(6, withAi(AI, 'hybrid')).mode).toBe('hybrid');
  });

  it('TC-110-03 a bad baseline is an error that names no value', () => {
    const bad: ((raw: ReturnType<typeof clone>) => void)[] = [
      raw => (raw.thresholds.medium = 0),
      raw => (raw.thresholds.high = 40),
      raw => (raw.thresholds.high = 2_147_483_648),
      raw => ((raw.thresholds as Record<string, unknown>).medium = '40'),
      raw => delete (raw.rules as Record<string, unknown>).R6,
      raw => ((raw.rules.R1 as Record<string, unknown>).enabled = 'yes'),
      raw => ((raw.rules.R1 as Record<string, unknown>).weight = -1),
      raw => ((raw.rules.R1 as Record<string, unknown>).weight = 2.5),
      raw => ((raw.rules.R1 as Record<string, unknown>).weight = 2_147_483_647),
      raw => ((raw.rules.R2 as Record<string, unknown>).medianMultiplier = { x: 1 }),
      raw => ((raw.rules.R2 as Record<string, unknown>).medianMultiplier = null),
      raw => ((raw.rules.R5 as Record<string, unknown>).sameOwnerExempt = false),
      raw => ((raw as Record<string, unknown>).rules = []),
    ];
    for (const mutate of bad) {
      const raw = clone();
      mutate(raw);
      expect(() => parseRuleSet(7, raw)).toThrow(InvalidRuleSetError);
    }
    expect(() => parseRuleSet(7, null)).toThrow(InvalidRuleSetError);
    expect(() => parseRuleSet(7, 'x')).toThrow(InvalidRuleSetError);
    expect(() => parseRuleSet(0, SEED_V1)).toThrow(InvalidRuleSetError);
    try {
      const raw = clone();
      raw.rules.R3.minAmountExclusive = 'secret-ish-value';
      (raw.rules.R1 as Record<string, unknown>).weight = 'leak-me';
      parseRuleSet(7, raw);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/leak-me|secret-ish/);
    }
  });

  it('TC-110-03 the rule weights together stay within the score range', () => {
    const raw = clone();
    for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'] as const)
      (raw.rules[id] as Record<string, unknown>).weight = 1_000_000_000;
    expect(() => parseRuleSet(8, raw)).toThrow(InvalidRuleSetError);
  });
});
