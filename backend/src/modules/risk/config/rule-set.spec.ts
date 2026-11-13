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

  it('BL-208 each rule has a schema: required keys, string money, value domains (H9)', () => {
    type Mutation = [string, (rules: Record<string, Record<string, unknown>>) => void];
    const bad: Mutation[] = [
      ['R1 maxTransfers missing', r => delete r.R1.maxTransfers],
      ['R1 maxTransfers negative', r => (r.R1.maxTransfers = -1)],
      ['R1 windowMinutes 11', r => (r.R1.windowMinutes = 11)],
      ['R2 historyDays 31', r => (r.R2.historyDays = 31)],
      ['R2 minHistory 4', r => (r.R2.minHistory = 4)],
      ['R2 multiplier 3 decimals', r => (r.R2.medianMultiplier = 1.005)],
      ['R2 multiplier 0', r => (r.R2.medianMultiplier = 0)],
      ['R3 minAmountExclusive number', r => (r.R3.minAmountExclusive = 10_000_000)],
      ['R3 minAmountExclusive junk', r => (r.R3.minAmountExclusive = '1e7')],
      ['R3 minAmountExclusive missing', r => delete r.R3.minAmountExclusive],
      ['R3 age 0', r => (r.R3.maxAccountAgeHoursExclusive = 0)],
      ['R3 age 87601', r => (r.R3.maxAccountAgeHoursExclusive = 87_601)],
      ['R3 age fraction', r => (r.R3.maxAccountAgeHoursExclusive = 1.5)],
      ['R4 window 0', r => (r.R4.reverseWindowMinutes = 0)],
      ['R4 window 61', r => (r.R4.reverseWindowMinutes = 61)],
      ['R4 window fraction', r => (r.R4.reverseWindowMinutes = 1.5)],
      ['R5 windowMinutes 59', r => (r.R5.windowMinutes = 59)],
      ['R5 noveltyDays 29', r => (r.R5.noveltyDays = 29)],
      ['R5 minNewRecipients 0', r => (r.R5.minNewRecipients = 0)],
      ['R6 percent 0', r => (r.R6.minBalancePercent = 0)],
      ['R6 percent 101', r => (r.R6.minBalancePercent = 101)],
      ['R6 percent fraction', r => (r.R6.minBalancePercent = 50.5)],
      ['R6 minBalance number', r => (r.R6.minBalance = 1_000_000)],
      ['R6 minBalance zero', r => (r.R6.minBalance = '0')],
    ];
    for (const [name, mutate] of bad) {
      const raw = clone();
      mutate(raw.rules);
      let thrown: unknown;
      try {
        parseRuleSet(9, raw);
      } catch (error) {
        thrown = error;
      }
      expect([name, thrown instanceof InvalidRuleSetError]).toEqual([name, true]);
    }
  });

  it('BL-208 a disabled rule is still checked: switching it off cannot hide a broken value', () => {
    const raw = clone();
    raw.rules.R3.enabled = false;
    raw.rules.R3.minAmountExclusive = 10_000_000 as unknown as string;
    expect(() => parseRuleSet(9, raw)).toThrow(InvalidRuleSetError);
  });

  it('BL-208 the error names the rule, never the value', () => {
    const raw = clone();
    (raw.rules.R3 as Record<string, unknown>).minAmountExclusive = 123_456_789;
    try {
      parseRuleSet(9, raw);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRuleSetError);
      expect((error as InvalidRuleSetError).field).toBe('rules.R3');
      expect((error as Error).message).not.toContain('123456789');
    }
  });

  it('TC-110-03 the rule weights together stay within the score range', () => {
    const raw = clone();
    for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'] as const)
      (raw.rules[id] as Record<string, unknown>).weight = 1_000_000_000;
    expect(() => parseRuleSet(8, raw)).toThrow(InvalidRuleSetError);
  });
});
