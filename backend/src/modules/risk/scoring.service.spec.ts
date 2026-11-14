import { register } from 'prom-client';
import type { AiAssessment } from './ai/ai-contract';
import type { Features, TransferEvent } from './features/feature-provider';
import { ScoringService, type ScoringConfig } from './scoring.service';
import type { RuleId, RuleParams } from './rules/rule';

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
const baseline: ScoringConfig = { thresholds: { medium: 40, high: 70 }, rules };
const withAi: ScoringConfig = {
  ...baseline,
  mode: 'rules_with_external_ai',
  ai: { threshold: 0.9, weight: 40 },
};
const assessment = (
  probability: number | null,
  status: AiAssessment['status'] = 'SUCCEEDED',
): AiAssessment => ({
  status,
  probability,
  provider: 'openai',
  requestedModel: 'test-model',
  responseModel: null,
  requestId: null,
  rubricSha256: null,
  inputSha256: null,
  usage: null,
});
const service = new ScoringService();

describe('DBS-108 fraud scoring', () => {
  it('matches guide examples for R6, R3+R6, R5 and R1+R5', () => {
    expect(service.score(event, facts, baseline)).toMatchObject({
      ruleScore: 30,
      score: 30,
      level: 'LOW',
      aiStatus: 'DISABLED',
    });
    const young = {
      ...event,
      amount: '20000000',
      fromBalanceBefore: '20800000',
      fromAccountCreatedAt: '2026-10-19T09:00:00.000Z',
    };
    expect(service.score(young, facts, baseline)).toMatchObject({
      ruleScore: 65,
      score: 65,
      level: 'MEDIUM',
    });
    const noDrain = { ...event, amount: '200000' };
    expect(service.score(noDrain, { ...facts, newRecipients1h: 5 }, baseline)).toMatchObject({
      ruleScore: 40,
      score: 40,
      level: 'MEDIUM',
    });
    expect(
      service.score(noDrain, { ...facts, newRecipients1h: 5, txCount10m: 6 }, baseline),
    ).toMatchObject({ ruleScore: 70, score: 70, level: 'HIGH' });
  });

  it('honors a disabled rule and allows scores above 100', () => {
    const disabled = { ...baseline, rules: { ...rules, R6: { ...rules.R6, enabled: false } } };
    expect(service.score(event, facts, disabled)).toMatchObject({ score: 0, hits: [] });
    const risky = {
      ...event,
      amount: '20000000',
      fromBalanceBefore: '20800000',
      fromAccountCreatedAt: '2026-10-19T09:00:00.000Z',
    };
    const busy = {
      ...facts,
      txCount10m: 6,
      historyCount30d: 5,
      medianAmount30dTimes2: '2000000',
      reverseTransferOccurredAt: '2026-10-19T11:45:00.000Z',
      newRecipients1h: 5,
    };
    const result = service.score(risky, busy, baseline);
    expect(result).toMatchObject({ ruleScore: 180, score: 180, level: 'HIGH' });
    expect(result?.hits.map(hit => hit.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
  });

  it('ignores every non-transfer before reading config or incrementing unsupported-mode metric', async () => {
    const counter = register.getSingleMetric('risk_unsupported_mode_total');
    const before = (await counter?.get())?.values[0]?.value ?? 0;
    for (const type of ['DEPOSIT', 'UNKNOWN', undefined]) {
      expect(
        service.score(
          { ...event, type } as unknown as TransferEvent,
          facts,
          null as unknown as ScoringConfig,
        ),
      ).toBeNull();
    }
    expect((await counter?.get())?.values[0]?.value ?? 0).toBe(before);
  });

  it.each(['R1', 'R2', 'R3', 'R4', 'R5', 'R6'] as RuleId[])(
    'rejects bad %s config even when disabled',
    id => {
      const bad = {
        ...baseline,
        rules: { ...rules, [id]: { ...rules[id], enabled: false, thresholds: {} } },
      };
      expect(() => service.score(event, facts, bad)).toThrow();
    },
  );

  it('rejects missing rule config and negative weight even if other hits would make a positive total', () => {
    const missing = { ...baseline, rules: { ...rules, R2: undefined } } as unknown as ScoringConfig;
    expect(() => service.score(event, facts, missing)).toThrow();
    const negative = { ...baseline, rules: { ...rules, R1: { ...rules.R1, weight: -1 } } };
    expect(() =>
      service.score(event, { ...facts, txCount10m: 6, newRecipients1h: 5 }, negative),
    ).toThrow();
  });

  it('supports AI-only flags without inventing rule hits', () => {
    const quiet = { ...event, amount: '100000' };
    expect(service.score(quiet, facts, withAi, assessment(0.9))).toMatchObject({
      mode: 'rules_with_external_ai',
      hits: [],
      ruleScore: 0,
      aiAppliedWeight: 40,
      score: 40,
      level: 'MEDIUM',
      aiStatus: 'SUCCEEDED',
    });
    expect(service.score(quiet, facts, withAi, assessment(0.899))).toMatchObject({
      score: 0,
      aiAppliedWeight: 0,
      aiStatus: 'SUCCEEDED',
    });
    expect(service.score(quiet, facts, withAi, assessment(0))).toMatchObject({
      score: 0,
      aiAppliedWeight: 0,
    });
    expect(service.score(quiet, facts, withAi, assessment(1))).toMatchObject({
      score: 40,
      aiAppliedWeight: 40,
    });
  });

  it('never lets a failed or low-probability AI result remove the rule baseline', () => {
    for (const input of [
      assessment(0.1),
      assessment(null, 'REFUSED'),
      assessment(null, 'UNAVAILABLE'),
      assessment(null, 'INVALID_RESPONSE'),
      assessment(null, 'BUDGET_EXHAUSTED'),
    ]) {
      expect(service.score(event, facts, withAi, input)).toMatchObject({
        ruleScore: 30,
        aiAppliedWeight: 0,
        score: 30,
        level: 'LOW',
      });
    }
    expect(service.score(event, facts, withAi, assessment(0.9))).toMatchObject({
      ruleScore: 30,
      aiAppliedWeight: 40,
      score: 70,
      level: 'HIGH',
    });
    expect(service.score(event, facts, baseline, assessment(1))).toMatchObject({
      ruleScore: 30,
      aiAppliedWeight: 0,
      score: 30,
      aiStatus: 'DISABLED',
    });
  });

  it.each([null, NaN, Infinity, -0.1, 1.1, '0.9', undefined])(
    'treats a malformed successful probability %s as invalid response',
    probability => {
      const bad = { ...assessment(0.9), probability } as unknown as AiAssessment;
      expect(service.score(event, facts, withAi, bad)).toMatchObject({
        score: 30,
        aiAppliedWeight: 0,
        aiStatus: 'INVALID_RESPONSE',
      });
    },
  );

  it('handles missing/malformed assessments and DISABLED explicitly', () => {
    expect(service.score(event, facts, withAi, null)).toMatchObject({
      score: 30,
      aiStatus: 'UNAVAILABLE',
    });
    expect(
      service.score(event, facts, withAi, { status: 'other' } as unknown as AiAssessment),
    ).toMatchObject({ score: 30, aiStatus: 'INVALID_RESPONSE' });
    expect(service.score(event, facts, withAi, assessment(null, 'DISABLED'))).toMatchObject({
      score: 30,
      aiStatus: 'CONFIG_INVALID',
    });
  });

  it('preserves the rule score when an AI-only property access fails', () => {
    const badAssessment = {
      get status(): never {
        throw new Error('provider parsing failure');
      },
    } as unknown as AiAssessment;
    expect(service.score(event, facts, withAi, badAssessment)).toMatchObject({
      score: 30,
      aiAppliedWeight: 0,
      aiStatus: 'INVALID_RESPONSE',
    });
    const badConfig = {
      ...withAi,
      get ai(): never {
        throw new Error('invalid AI configuration');
      },
    } as unknown as ScoringConfig;
    expect(service.score(event, facts, badConfig, assessment(1))).toMatchObject({
      score: 30,
      aiAppliedWeight: 0,
      aiStatus: 'CONFIG_INVALID',
    });
  });

  it('keeps the baseline when the AI assessment is a revoked proxy', () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(service.score(event, facts, withAi, revocable.proxy as AiAssessment)).toMatchObject({
      score: 30,
      aiAppliedWeight: 0,
      aiStatus: 'INVALID_RESPONSE',
    });
  });

  it.each([
    null,
    undefined,
    {},
    { threshold: 0, weight: 1 },
    { threshold: '0.9', weight: 1 },
    { threshold: 0.9, weight: -1 },
    { threshold: 0.9, weight: 2147483648 },
  ])('falls back for invalid AI config', ai => {
    expect(
      service.score(event, facts, { ...withAi, ai } as unknown as ScoringConfig, assessment(1)),
    ).toMatchObject({ score: 30, aiStatus: 'CONFIG_INVALID', aiAppliedWeight: 0 });
  });

  it('counts unsupported modes once for each attempted transfer, even if baseline later errors', async () => {
    const counter = register.getSingleMetric('risk_unsupported_mode_total');
    const before = (await counter?.get())?.values[0]?.value ?? 0;
    const unknown = { ...baseline, mode: 'not-a-mode' };
    expect(service.score(event, facts, unknown, assessment(1))).toMatchObject({
      score: 30,
      mode: 'rule_only',
      aiStatus: 'DISABLED',
    });
    expect(() =>
      service.score(event, facts, { ...unknown, thresholds: { medium: 70, high: 40 } }),
    ).toThrow();
    expect((await counter?.get())?.values[0]?.value).toBe(before + 2);
  });

  it('rejects baseline overflow and falls back only when applied AI would overflow', () => {
    const atMax = { ...baseline, rules: { ...rules, R6: { ...rules.R6, weight: 2147483647 } } };
    expect(service.score(event, facts, atMax)).toMatchObject({
      ruleScore: 2147483647,
      score: 2147483647,
    });
    expect(() => service.score(event, { ...facts, newRecipients1h: 5 }, atMax)).toThrow();
    const nearMaxAi = {
      ...atMax,
      mode: 'rules_with_external_ai',
      ai: { threshold: 0.9, weight: 1 },
    };
    expect(service.score(event, facts, nearMaxAi, assessment(0.9))).toMatchObject({
      score: 2147483647,
      aiAppliedWeight: 0,
      aiStatus: 'CONFIG_INVALID',
    });
    expect(service.score(event, facts, nearMaxAi, assessment(0.8))).toMatchObject({
      score: 2147483647,
      aiAppliedWeight: 0,
      aiStatus: 'SUCCEEDED',
    });
  });

  it.each([
    { medium: 0, high: 70 },
    { medium: 70, high: 40 },
    { medium: 40.5, high: 70 },
    { medium: 40, high: 2147483648 },
  ])('rejects invalid baseline risk thresholds', thresholds => {
    expect(() => service.score(event, facts, { ...baseline, thresholds })).toThrow();
  });

  // BL-212 (DBS-108 review #3): the examples of FRAUD_DETECTION_GUIDE §4.3 and AC-9.1 (BRD), with the
  // wording and numbers of the documents, not numbers chosen to be convenient for the code.
  describe('guide §4.3 table, verbatim', () => {
    const hitIds = (result: ReturnType<ScoringService['score']>) => result?.hits.map(h => h.id);
    // "Tài khoản 3 giờ tuổi chuyển 20tr, gần hết số dư": R3 + R6 (the account of §4.4: 20,8tr balance).
    const threeHoursOld = {
      ...event,
      amount: '20000000',
      fromBalanceBefore: '20800000',
      fromAccountCreatedAt: '2026-10-19T09:00:00.000Z',
    };

    it('"Khách chuyển 95% số dư sang người quen" → R6, 30, LOW (no flag)', () => {
      const result = service.score({ ...event, amount: '950000' }, facts, baseline);
      expect(hitIds(result)).toEqual(['R6']);
      expect(result).toMatchObject({ ruleScore: 30, score: 30, level: 'LOW' });
    });

    it('"Tài khoản 3 giờ tuổi chuyển 20tr, gần hết số dư" → R3 + R6, 65, MEDIUM', () => {
      const result = service.score(threeHoursOld, facts, baseline);
      expect(hitIds(result)).toEqual(['R3', 'R6']);
      expect(result).toMatchObject({ ruleScore: 65, score: 65, level: 'MEDIUM' });
    });

    it('"6 người nhận mới trong 1 giờ" → R5, 40, MEDIUM', () => {
      const result = service.score(
        { ...event, amount: '200000' },
        { ...facts, newRecipients1h: 6 },
        baseline,
      );
      expect(hitIds(result)).toEqual(['R5']);
      expect(result).toMatchObject({ ruleScore: 40, score: 40, level: 'MEDIUM' });
    });

    it('"8 lệnh / 10 phút, toàn người nhận mới" → R1 + R5, 70, HIGH', () => {
      const result = service.score(
        { ...event, amount: '200000' },
        { ...facts, txCount10m: 8, txCount1h: 8, newRecipients1h: 8 },
        baseline,
      );
      expect(hitIds(result)).toEqual(['R1', 'R5']);
      expect(result).toMatchObject({ ruleScore: 70, score: 70, level: 'HIGH' });
    });

    it('§4.4: the hits of the 3-hour-old account read as the example flag does', () => {
      const result = service.score(threeHoursOld, facts, baseline);
      expect(result?.hits.map(h => [h.id, h.explanation])).toEqual([
        ['R3', 'Tài khoản mở 3 giờ trước, chuyển 20.000.000đ'],
        ['R6', 'Chuyển xấp xỉ 96,15% số dư (20.000.000đ/20.800.000đ).'],
      ]);
    });
  });

  describe('AC-9.1 verbatim', () => {
    // "Tài khoản nguồn mở 1 giờ, số dư trước 21 triệu, chuyển 20 triệu tới tài khoản khác chủ"
    const ac91 = {
      ...event,
      amount: '20000000',
      fromBalanceBefore: '21000000',
      fromAccountCreatedAt: '2026-10-19T11:00:00.000Z',
      sameOwner: false,
    };

    it('matches R3 and R6 only, 35 + 30 = 65, one MEDIUM flag naming R3 and R6', () => {
      const result = service.score(ac91, facts, baseline);
      expect(result?.hits.map(h => h.id)).toEqual(['R3', 'R6']);
      expect(result?.hits.map(h => h.weight)).toEqual([35, 30]);
      expect(result).toMatchObject({ ruleScore: 65, score: 65, level: 'MEDIUM' });
    });

    it('R6 alone (30) is not enough to create a flag', () => {
      const old = { ...ac91, fromAccountCreatedAt: '2026-01-01T00:00:00.000Z' };
      const result = service.score(old, facts, baseline);
      expect(result?.hits.map(h => h.id)).toEqual(['R6']);
      expect(result).toMatchObject({ score: 30, level: 'LOW' });
    });
  });
});
