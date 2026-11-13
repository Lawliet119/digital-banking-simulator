import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { TransactionService } from '@database/transaction.service';
import type { AuditService } from '@modules/audit';
import { parseRuleSet } from './config/rule-set';
import { RiskConfigHttpService } from './risk-config-http.service';
import { validateRiskConfig } from './risk-config-validation';

type Rules = Record<string, Record<string, unknown>>;
type Config = { mode: string; thresholds: Record<string, unknown>; rules: Rules } & Record<
  string,
  unknown
>;

const SEED: Config = {
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
const clone = (): Config => structuredClone(SEED);

/** BL-188: every value a rule would throw on is refused before the write, one case per constraint. */
const REJECTED: [string, (rules: Rules) => void][] = [
  ['R1 windowMinutes is 10', r => (r.R1.windowMinutes = 11)],
  ['R1 maxTransfers is a non-negative integer', r => (r.R1.maxTransfers = -1)],
  ['R1 maxTransfers is a number', r => (r.R1.maxTransfers = '5')],
  ['R2 historyDays is 30', r => (r.R2.historyDays = 29)],
  ['R2 minHistory is at least 5', r => (r.R2.minHistory = 4)],
  ['R2 minHistory is an integer', r => (r.R2.minHistory = 5.5)],
  ['R2 multiplier has at most 2 decimals', r => (r.R2.medianMultiplier = 2.005)],
  ['R2 multiplier is positive', r => (r.R2.medianMultiplier = 0)],
  ['R2 multiplier is at most 1000', r => (r.R2.medianMultiplier = 1001)],
  ['R3 minAmountExclusive is a string', r => (r.R3.minAmountExclusive = 10_000_000)],
  ['R3 minAmountExclusive is valid money', r => (r.R3.minAmountExclusive = '10,5')],
  ['R3 minAmountExclusive is not negative', r => (r.R3.minAmountExclusive = '-1')],
  ['R3 age is at least 1 hour', r => (r.R3.maxAccountAgeHoursExclusive = 0)],
  ['R3 age is at most 87600 hours', r => (r.R3.maxAccountAgeHoursExclusive = 87_601)],
  ['R3 age is an integer', r => (r.R3.maxAccountAgeHoursExclusive = 24.5)],
  ['R4 window is at least 1', r => (r.R4.reverseWindowMinutes = 0)],
  ['R4 window is at most 60', r => (r.R4.reverseWindowMinutes = 61)],
  ['R4 window is an integer', r => (r.R4.reverseWindowMinutes = 30.5)],
  ['R5 windowMinutes is 60', r => (r.R5.windowMinutes = 30)],
  ['R5 noveltyDays is 30', r => (r.R5.noveltyDays = 7)],
  ['R5 minNewRecipients is at least 1', r => (r.R5.minNewRecipients = 0)],
  ['R5 sameOwnerExempt stays true', r => (r.R5.sameOwnerExempt = false)],
  ['R6 percent is at least 1', r => (r.R6.minBalancePercent = 0)],
  ['R6 percent is at most 100', r => (r.R6.minBalancePercent = 101)],
  ['R6 percent is an integer', r => (r.R6.minBalancePercent = 90.5)],
  ['R6 minBalance is a string', r => (r.R6.minBalance = 1_000_000)],
  ['R6 minBalance is positive', r => (r.R6.minBalance = '0')],
  ['R6 minBalance is valid money', r => (r.R6.minBalance = 'abc')],
  ['every rule needs its keys', r => delete r.R2.minHistory],
  ['no unknown key', r => (r.R4.extra = 1)],
  ['weight is within int4', r => (r.R1.weight = 2_147_483_647)],
];

describe('BL-188 validateRiskConfig (the write boundary of UC-12)', () => {
  it('accepts the seed configuration unchanged', () => {
    const config = clone();
    expect(validateRiskConfig(config)).toBe(config);
  });

  it.each(REJECTED)('rejects: %s', (_name, mutate) => {
    const config = clone();
    mutate(config.rules);
    expect(() => validateRiskConfig(config)).toThrow(BadRequestException);
    expect(() => validateRiskConfig(config)).toThrow('Invalid risk configuration');
  });

  it.each(REJECTED.filter(([name]) => !/needs its keys|unknown key/.test(name)))(
    'rejects while the rule is switched off: %s',
    (_name, mutate) => {
      const config = clone();
      mutate(config.rules);
      for (const rule of Object.values(config.rules)) rule.enabled = false;
      expect(() => validateRiskConfig(config)).toThrow(BadRequestException);
    },
  );

  it('uses the worker read check: nothing the API accepts is refused by parseRuleSet', () => {
    const accepted = clone();
    accepted.rules.R2.medianMultiplier = 2.5;
    accepted.rules.R4.reverseWindowMinutes = 1;
    accepted.rules.R6.minBalancePercent = 100;
    accepted.rules.R3.maxAccountAgeHoursExclusive = 87_600;
    validateRiskConfig(accepted);
    expect(() => parseRuleSet(1, accepted)).not.toThrow();
  });

  it('refuses what parseRuleSet refuses, whatever the rule list says', () => {
    for (const [, mutate] of REJECTED) {
      const config = clone();
      mutate(config.rules);
      let readerRefuses = false;
      try {
        parseRuleSet(1, config);
      } catch {
        readerRefuses = true;
      }
      // The write boundary is at least as strict as the read check.
      if (readerRefuses) expect(() => validateRiskConfig(config)).toThrow(BadRequestException);
    }
  });
});

describe('BL-188 RiskConfigHttpService.create writes nothing for a refused configuration', () => {
  it('rejects before it opens a transaction', async () => {
    const run = jest.fn();
    const service = new RiskConfigHttpService(
      {} as DataSource,
      { run } as unknown as TransactionService,
      {} as AuditService,
    );
    const config = clone();
    config.rules.R3.minAmountExclusive = 10_000_000;
    await expect(service.create(config, 'actor', 'corr')).rejects.toThrow(BadRequestException);
    expect(run).not.toHaveBeenCalled();
  });
});
