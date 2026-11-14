import { MONEY_MAX } from '@common/money';
import type { Features, TransferEvent } from '../features/feature-provider';
import type { RuleParams } from './rule';
import { R2UnusualAmountRule } from './r2-unusual-amount.rule';

const baseEvent: TransferEvent = {
  eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
  eventType: 'TransferCompleted',
  occurredAt: '2026-10-19T03:15:42.123Z',
  correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
  transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
  type: 'TRANSFER',
  fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
  toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  amount: '500000',
  fromBalanceBefore: '520000',
  fromAccountCreatedAt: '2026-09-30T08:00:00.000Z',
  toAccountCreatedAt: '2026-01-15T08:00:00.000Z',
  sameOwner: false,
  fromUserId: 'b2e5c8a1-6f40-4d93-8c17-a9d3f0e6b724',
  toUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
};

const baseFeatures: Features = {
  txCount10m: 1,
  txCount1h: 1,
  historyCount30d: 12,
  medianAmount30dTimes2: '2000000', // median 1 000 000
  reverseTransferOccurredAt: null,
  newRecipients1h: 1,
  distinctRecipients24h: 1,
  sumOut24h: '500000',
  smallTxCount24h: 1,
};

const v1: RuleParams = {
  enabled: true,
  weight: 25,
  thresholds: { medianMultiplier: 5, historyDays: 30, minHistory: 5 },
};

const withThresholds = (thresholds: Record<string, unknown>, extra: Partial<RuleParams> = {}) =>
  ({ ...v1, ...extra, thresholds }) as unknown as RuleParams;
const ev = (amount: unknown): TransferEvent =>
  ({ ...baseEvent, amount }) as unknown as TransferEvent;
const ft = (overrides: Record<string, unknown>): Features => ({ ...baseFeatures, ...overrides });

describe('DBS-94 R2 unusual amount', () => {
  const rule = new R2UnusualAmountRule();
  const run = (
    amount: string,
    features: Features = baseFeatures,
    params: RuleParams = v1,
  ): ReturnType<R2UnusualAmountRule['evaluate']> => rule.evaluate(ev(amount), features, params);

  it('TC-94-01 triggers strictly above 5x the median, not at exactly 5x', () => {
    expect(run('5000000')).toBeNull();
    expect(run('5000001')).toMatchObject({ id: 'R2', weight: 25 });
  });

  it('TC-94-02 keeps a half median exact: no rounding at the boundary', () => {
    const half = ft({ medianAmount30dTimes2: '2000001' }); // median 1 000 000,5 -> 5x = 5 000 002,5
    expect(run('5000002', half)).toBeNull();
    expect(run('5000003', half)).toMatchObject({ id: 'R2' });
  });

  it('TC-94-03 skips below the minimum history, before reading the median', () => {
    expect(run('900000000', ft({ historyCount30d: 4, medianAmount30dTimes2: null }))).toBeNull();
    expect(run('900000000', ft({ historyCount30d: 4 }))).toBeNull(); // median present: still skipped
    expect(run('900000000', ft({ historyCount30d: 0, medianAmount30dTimes2: null }))).toBeNull();
    expect(run('5000000', ft({ historyCount30d: 5 }))).toBeNull();
    expect(run('5000001', ft({ historyCount30d: 5 }))).toMatchObject({ id: 'R2' });
  });

  it('TC-94-03 honours a higher configured minHistory', () => {
    const min7 = withThresholds({ medianMultiplier: 5, historyDays: 30, minHistory: 7 });
    expect(run('9000000', ft({ historyCount30d: 6 }), min7)).toBeNull();
    expect(
      run('9000000', ft({ historyCount30d: 6, medianAmount30dTimes2: null }), min7),
    ).toBeNull();
    expect(run('9000000', ft({ historyCount30d: 7 }), min7)).toMatchObject({ id: 'R2' });
  });

  it.each([5, 8])('TC-94-03 a missing median with %i history rows is a provider fault', count => {
    expect(() =>
      run('9000000', ft({ historyCount30d: count, medianAmount30dTimes2: null })),
    ).toThrow(Error);
  });

  it('TC-94-04 compares exactly above 2^53', () => {
    const m = ft({ medianAmount30dTimes2: '3602879701896398' }); // median 1 801 439 850 948 199
    expect(run('9007199254740995', m)).toBeNull(); // exactly 5x
    expect(run('9007199254740996', m)).toMatchObject({ id: 'R2' }); // a float says no hit here
  });

  it('TC-94-04 handles a doubled median above 2^53 and the largest amounts', () => {
    const one = withThresholds({ medianMultiplier: 1, historyDays: 30, minHistory: 5 });
    const max = String(MONEY_MAX);
    expect(run(max, ft({ medianAmount30dTimes2: '18446744073709551612' }), one)).toMatchObject({
      id: 'R2',
    });
    expect(run(max, ft({ medianAmount30dTimes2: '18446744073709551614' }), one)).toBeNull();
    const hit = run(max, ft({ medianAmount30dTimes2: '2' }));
    // BL-184 H7: one money format (dot-grouped, `đ`), shared with R3 and R6.
    expect(hit?.explanation).toBe(
      'Số tiền 9.223.372.036.854.775.807đ gấp 9.223.372.036.854.775.807× trung vị 30 ngày (1đ)',
    );
  });

  it.each([
    ['50000000', '8000000', 'Số tiền 50.000.000đ gấp 12,5× trung vị 30 ngày (4.000.000đ)'],
    ['5000001', '2000000', 'Số tiền 5.000.001đ gấp hơn 5× trung vị 30 ngày (1.000.000đ)'],
    ['5009999', '2000000', 'Số tiền 5.009.999đ gấp hơn 5× trung vị 30 ngày (1.000.000đ)'],
    ['5010000', '2000000', 'Số tiền 5.010.000đ gấp 5,01× trung vị 30 ngày (1.000.000đ)'],
    ['10050000', '2000000', 'Số tiền 10.050.000đ gấp 10,05× trung vị 30 ngày (1.000.000đ)'],
    ['10500000', '2000000', 'Số tiền 10.500.000đ gấp 10,5× trung vị 30 ngày (1.000.000đ)'],
    ['12000000', '2000000', 'Số tiền 12.000.000đ gấp 12× trung vị 30 ngày (1.000.000đ)'],
    ['8', '3', 'Số tiền 8đ gấp 5,33× trung vị 30 ngày (1,5đ)'],
    ['5000003', '2000001', 'Số tiền 5.000.003đ gấp hơn 5× trung vị 30 ngày (1.000.000,5đ)'],
  ])('TC-94-05 explains amount %s against doubled median %s', (amount, doubled, expected) => {
    expect(run(amount, ft({ medianAmount30dTimes2: doubled }))?.explanation).toBe(expected);
  });

  it('TC-94-05 shows the configured multiplier when the excess is tiny, also a decimal one', () => {
    const one = withThresholds({ medianMultiplier: 1, historyDays: 30, minHistory: 5 });
    expect(run('1004000', baseFeatures, one)?.explanation).toBe(
      'Số tiền 1.004.000đ gấp hơn 1× trung vị 30 ngày (1.000.000đ)',
    );
    const m35 = withThresholds({ medianMultiplier: 3.5, historyDays: 30, minHistory: 5 });
    expect(run('3500001', baseFeatures, m35)?.explanation).toBe(
      'Số tiền 3.500.001đ gấp hơn 3,5× trung vị 30 ngày (1.000.000đ)',
    );
    expect(run('7000000', baseFeatures, m35)?.explanation).toBe(
      'Số tiền 7.000.000đ gấp 7× trung vị 30 ngày (1.000.000đ)',
    );
  });

  it('TC-94-06 does not trigger when disabled', () => {
    expect(run('900000000', baseFeatures, { ...v1, enabled: false })).toBeNull();
  });

  // BL-207(a): a switched-off rule judges only its configuration, never the provider's data.
  describe('disabled rule ignores bad data', () => {
    const off = { ...v1, enabled: false };
    it.each([-1, 1.5, NaN, '6', undefined])('historyCount30d %p', count => {
      expect(run('9000000', ft({ historyCount30d: count }), off)).toBeNull();
    });
    it.each(['abc', 4, undefined, '1.5'])('medianAmount30dTimes2 %p', median => {
      expect(run('9000000', ft({ medianAmount30dTimes2: median }), off)).toBeNull();
    });
    it.each(['0', '', 5, undefined])('amount %p', amount => {
      expect(rule.evaluate(ev(amount), baseFeatures, off)).toBeNull();
    });
  });

  it('TC-94-06 uses the configured multiplier and weight instead of the seed', () => {
    const configured = withThresholds(
      { medianMultiplier: 3, historyDays: 30, minHistory: 5 },
      { weight: 12 },
    );
    expect(run('3000000', baseFeatures, configured)).toBeNull();
    expect(run('3000001', baseFeatures, configured)).toMatchObject({ id: 'R2', weight: 12 });
  });

  it('TC-94-06 compares a fractional multiplier exactly', () => {
    const m35 = withThresholds({ medianMultiplier: 3.5, historyDays: 30, minHistory: 5 });
    expect(run('3500000', baseFeatures, m35)).toBeNull();
    expect(run('3500001', baseFeatures, m35)).toMatchObject({ id: 'R2' });
  });

  it('TC-94-07 accepts the largest valid weight and rejects one more', () => {
    expect(run('9000000', baseFeatures, { ...v1, weight: 2147483647 })).toMatchObject({
      weight: 2147483647,
    });
    expect(() => run('9000000', baseFeatures, { ...v1, weight: 2147483648 })).toThrow(Error);
  });

  const badWeights = [-1, 1.5, NaN, Infinity, 2147483648, '25'];
  const goodT = { medianMultiplier: 5, historyDays: 30, minHistory: 5 };
  const badThresholds: Record<string, unknown>[] = [
    ...[0, -1, NaN, Infinity, '5', 1000.01, 1.005, 2 ** 53, null].map(medianMultiplier => ({
      ...goodT,
      medianMultiplier,
    })),
    ...[15, '30', 0, NaN, null].map(historyDays => ({ ...goodT, historyDays })),
    ...[4, 5.5, '5', NaN, Infinity, null].map(minHistory => ({ ...goodT, minHistory })),
    { historyDays: 30, minHistory: 5 },
    { medianMultiplier: 5, minHistory: 5 },
    { medianMultiplier: 5, historyDays: 30 },
    {},
  ];

  describe.each([true, false])('configuration is validated with enabled=%s', enabled => {
    it.each(badWeights)('TC-94-07 rejects weight %p', weight => {
      expect(() => run('9000000', baseFeatures, { ...v1, enabled, weight } as RuleParams)).toThrow(
        Error,
      );
    });
    it.each(badThresholds.map((t, i) => [i, t] as const))(
      'TC-94-07 rejects thresholds case %i',
      (_i, thresholds) => {
        expect(() => run('9000000', baseFeatures, withThresholds(thresholds, { enabled }))).toThrow(
          Error,
        );
      },
    );
    it('TC-94-07 rejects missing thresholds and a non-boolean enabled', () => {
      expect(() =>
        run('9000000', baseFeatures, { enabled, weight: 25 } as unknown as RuleParams),
      ).toThrow(Error);
      expect(() =>
        run('9000000', baseFeatures, { ...v1, enabled: 'yes' } as unknown as RuleParams),
      ).toThrow(Error);
    });
  });

  it.each([-1, 1.5, NaN, '6', undefined])('TC-94-07 rejects historyCount30d %p', count => {
    expect(() => run('9000000', ft({ historyCount30d: count }))).toThrow(Error);
  });

  it.each([
    '',
    '1',
    '0',
    '1.5',
    '-2',
    '007',
    'abc',
    4,
    undefined,
    '18446744073709551615',
    '9'.repeat(40),
  ])('TC-94-07 rejects medianAmount30dTimes2 %p when the history is long enough', median => {
    expect(() => run('9000000', ft({ medianAmount30dTimes2: median }))).toThrow(Error);
  });

  it('TC-94-07 accepts the largest doubled median', () => {
    const one = withThresholds({ medianMultiplier: 1, historyDays: 30, minHistory: 5 });
    expect(run('1', ft({ medianAmount30dTimes2: '18446744073709551614' }), one)).toBeNull();
  });

  it.each(['0', '', '-5', '007', ' 5', '1e3', '9223372036854775808', 5, undefined])(
    'TC-94-07 rejects amount %p',
    amount => {
      expect(() => rule.evaluate(ev(amount), baseFeatures, v1)).toThrow(Error);
    },
  );

  it('TC-94-07 never echoes the offending input in the error message', () => {
    const secret = 'SECRET-123456';
    const cases: (() => unknown)[] = [
      () => run('9000000', ft({ medianAmount30dTimes2: secret })),
      () => rule.evaluate(ev(secret), baseFeatures, v1),
      () => run('9000000', baseFeatures, withThresholds({ ...goodT, medianMultiplier: secret })),
      () => run('9000000', baseFeatures, { ...v1, weight: secret } as unknown as RuleParams),
    ];
    for (const attempt of cases) {
      let message = '';
      try {
        attempt();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('SECRET');
    }
  });

  it('TC-94-08 never scores a DEPOSIT, whatever the data looks like', () => {
    const deposit = { ...baseEvent, type: 'DEPOSIT' } as unknown as TransferEvent;
    expect(rule.evaluate(deposit, baseFeatures, v1)).toBeNull();
    expect(
      rule.evaluate(deposit, ft({ historyCount30d: -1, medianAmount30dTimes2: 'abc' }), v1),
    ).toBeNull();
    expect(rule.evaluate(deposit, baseFeatures, withThresholds({}))).toBeNull();
  });
});
