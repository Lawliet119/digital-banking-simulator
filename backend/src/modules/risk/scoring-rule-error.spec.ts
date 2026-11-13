import { register } from 'prom-client';
import type { Features, TransferEvent } from './features/feature-provider';
import { RiskRuleError } from './risk-rule-error';
import { RULE_ERROR_METRIC } from './risk-scoring.metrics';
import { R3NewAccountLargeTransferRule } from './rules/r3-new-account-large-transfer.rule';
import { R5FanOutRule } from './rules/r5-fan-out.rule';
import type { RuleId, RuleParams } from './rules/rule';
import { ScoringService, type ScoringConfig } from './scoring.service';

const event: TransferEvent = {
  eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
  eventType: 'TransferCompleted',
  occurredAt: '2026-10-19T12:00:00.000Z',
  correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
  transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
  type: 'TRANSFER',
  fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
  toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  amount: '950000',
  fromBalanceBefore: '1000000',
  fromAccountCreatedAt: '2026-01-01T00:00:00.000Z',
  toAccountCreatedAt: '2026-01-15T08:00:00.000Z',
  sameOwner: false,
  fromUserId: 'b2e5c8a1-6f40-4d93-8c17-a9d3f0e6b724',
  toUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
};
const facts: Features = {
  txCount10m: 1,
  txCount1h: 1,
  historyCount30d: 0,
  medianAmount30dTimes2: null,
  reverseTransferOccurredAt: null,
  newRecipients1h: 1,
  distinctRecipients24h: 1,
  sumOut24h: '950000',
  smallTxCount24h: 0,
};
const rules: Record<RuleId, RuleParams> = {
  R1: { enabled: true, weight: 30, thresholds: { maxTransfers: 5, windowMinutes: 10 } },
  R2: {
    enabled: true,
    weight: 25,
    thresholds: { medianMultiplier: 5, historyDays: 30, minHistory: 5 },
  },
  R3: {
    enabled: true,
    weight: 35,
    thresholds: { maxAccountAgeHoursExclusive: 24, minAmountExclusive: '10000000' },
  },
  R4: { enabled: true, weight: 20, thresholds: { reverseWindowMinutes: 60 } },
  R5: {
    enabled: true,
    weight: 40,
    thresholds: { minNewRecipients: 5, windowMinutes: 60, noveltyDays: 30 },
  },
  R6: { enabled: true, weight: 30, thresholds: { minBalancePercent: 90, minBalance: '1000000' } },
};
const config: ScoringConfig = { thresholds: { medium: 40, high: 70 }, rules };

async function errorsOf(rule: string): Promise<number> {
  const values = (await register.getSingleMetric(RULE_ERROR_METRIC)?.get())?.values ?? [];
  return values.find(v => v.labels.rule === rule)?.value ?? 0;
}

describe('ScoringService wraps a rule failure (BL-207 f, BL-046, ADR-14)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('TC-207-F1 a rule that throws becomes RiskRuleError{ruleId}, still thrown, and counts risk_rule_error_total{rule}', async () => {
    const cause = new Error('boom with amount 950000');
    jest.spyOn(R3NewAccountLargeTransferRule.prototype, 'evaluate').mockImplementation(() => {
      throw cause;
    });
    const before = await errorsOf('R3');
    const others = await errorsOf('R1');

    let caught: unknown;
    try {
      new ScoringService().score(event, facts, config);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RiskRuleError);
    expect(caught).toMatchObject({ ruleId: 'R3', name: 'RiskRuleError' });
    expect((caught as RiskRuleError).cause).toBe(cause);
    // The message names the rule only: nothing of the event or of the original message.
    expect((caught as Error).message).toBe('Risk rule R3 threw');
    expect(await errorsOf('R3')).toBe(before + 1);
    expect(await errorsOf('R1')).toBe(others);
  });

  it('TC-207-F2 a rule that returns an invalid result is a rule error too, counted under its own id', async () => {
    jest
      .spyOn(R5FanOutRule.prototype, 'evaluate')
      .mockReturnValue({ id: 'R5', weight: 40, explanation: '' });
    const before = await errorsOf('R5');
    expect(() => new ScoringService().score(event, facts, config)).toThrow(RiskRuleError);
    expect(await errorsOf('R5')).toBe(before + 1);
  });

  it('TC-207-F3 a rule that returns something that is not an object is a rule error, not a TypeError', () => {
    jest.spyOn(R5FanOutRule.prototype, 'evaluate').mockReturnValue(undefined as never);
    expect(() => new ScoringService().score(event, facts, config)).toThrow(RiskRuleError);
  });

  it('TC-207-F4 nothing is counted when every rule answers, and a configuration error is not a rule error', async () => {
    const before = await errorsOf('R1');
    expect(new ScoringService().score(event, facts, config)).not.toBeNull();
    expect(() =>
      new ScoringService().score(event, facts, { ...config, rules: {} as never }),
    ).toThrow('Invalid risk rule configuration');
    expect(await errorsOf('R1')).toBe(before);
  });
});
