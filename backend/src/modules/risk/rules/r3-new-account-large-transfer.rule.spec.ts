import { MONEY_MAX } from '@common/money';
import type { Features, TransferEvent } from '../features/feature-provider';
import type { RuleParams } from './rule';
import { R3NewAccountLargeTransferRule } from './r3-new-account-large-transfer.rule';

const OCCURRED_AT = '2026-10-19T03:15:42.123Z';
const MIN = 60_000;
const HOUR = 60 * MIN;

const baseEvent: TransferEvent = {
  eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
  eventType: 'TransferCompleted',
  occurredAt: OCCURRED_AT,
  correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
  transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
  type: 'TRANSFER',
  fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
  toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  amount: '20000000',
  fromBalanceBefore: '25000000',
  fromAccountCreatedAt: '2026-10-19T00:15:42.123Z',
  toAccountCreatedAt: '2026-01-15T08:00:00.000Z',
  sameOwner: false,
  fromUserId: 'b2e5c8a1-6f40-4d93-8c17-a9d3f0e6b724',
  toUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
};

// R3 reads only the event snapshot; the provider's facts are not used.
const features = {} as unknown as Features;

const v1: RuleParams = {
  enabled: true,
  weight: 35,
  thresholds: { maxAccountAgeHoursExclusive: 24, minAmountExclusive: '10000000' },
};
const goodThresholds = { maxAccountAgeHoursExclusive: 24, minAmountExclusive: '10000000' };

const withThresholds = (thresholds: unknown, extra: Partial<RuleParams> = {}) =>
  ({ ...v1, ...extra, thresholds }) as unknown as RuleParams;
const ageOf = (ms: number, occurredAt = OCCURRED_AT): string =>
  new Date(Date.parse(occurredAt) - ms).toISOString();

describe('DBS-95 R3 new account, large transfer', () => {
  const rule = new R3NewAccountLargeTransferRule();
  const run = (fields: Record<string, unknown>, params: RuleParams = v1) =>
    rule.evaluate({ ...baseEvent, ...fields }, features, params);
  const atAge = (ms: number, fields: Record<string, unknown> = {}, params: RuleParams = v1) =>
    run({ fromAccountCreatedAt: ageOf(ms), ...fields }, params);

  it('TC-95-01 triggers strictly below 24 hours, not at exactly 24 hours', () => {
    expect(atAge(24 * HOUR)).toBeNull();
    expect(atAge(24 * HOUR - 1)).toMatchObject({ id: 'R3', weight: 35 });
    expect(atAge(24 * HOUR + 1)).toBeNull();
  });

  it('preserves nanosecond precision at the exclusive age boundary', () => {
    const occurredAt = '2026-10-19T12:00:00.000000001Z';
    expect(
      run({ occurredAt, fromAccountCreatedAt: '2026-10-18T12:00:00.000000002Z' }),
    ).not.toBeNull();
    expect(run({ occurredAt, fromAccountCreatedAt: '2026-10-18T12:00:00.000000001Z' })).toBeNull();
    expect(run({ occurredAt, fromAccountCreatedAt: '2026-10-18T12:00:00.000000000Z' })).toBeNull();
  });

  it('TC-95-01 counts exactly 24 hours across a daylight-saving date (UTC only)', () => {
    const occurredAt = '2026-03-29T12:00:00.000Z';
    expect(run({ occurredAt, fromAccountCreatedAt: '2026-03-28T12:00:00.000Z' })).toBeNull();
    expect(run({ occurredAt, fromAccountCreatedAt: '2026-03-28T12:00:00.001Z' })).not.toBeNull();
  });

  it('TC-95-01 accepts the edge values 1 and 87600 hours for the age limit', () => {
    const one = withThresholds({ ...goodThresholds, maxAccountAgeHoursExclusive: 1 });
    expect(atAge(59 * MIN, {}, one)).not.toBeNull();
    expect(atAge(HOUR, {}, one)).toBeNull();
    const max = withThresholds({ ...goodThresholds, maxAccountAgeHoursExclusive: 87600 });
    expect(atAge(HOUR, {}, max)).not.toBeNull();
  });

  it('TC-95-02 triggers strictly above 10,000,000, not at exactly 10,000,000', () => {
    expect(atAge(HOUR, { amount: '10000000' })).toBeNull();
    expect(atAge(HOUR, { amount: '10000001' })).toMatchObject({ id: 'R3' });
  });

  it('TC-95-02 a zero floor flags any positive amount; sameOwner does not exempt R3', () => {
    const zero = withThresholds({ ...goodThresholds, minAmountExclusive: '0' });
    expect(atAge(HOUR, { amount: '1' }, zero)).toMatchObject({ id: 'R3' });
    expect(atAge(HOUR, { sameOwner: true })).toMatchObject({ id: 'R3' });
  });

  it('TC-95-03 flags a young account moving a large amount, with the guide wording', () => {
    expect(atAge(3 * HOUR)).toEqual({
      id: 'R3',
      weight: 35,
      explanation: 'Tài khoản mở 3 giờ trước, chuyển 20.000.000đ',
    });
  });

  it('TC-95-04 needs both conditions: an old account or a small amount is not flagged', () => {
    expect(atAge(30 * 24 * HOUR, { amount: '1000000000' })).toBeNull();
    expect(atAge(MIN, { amount: '1000000' })).toBeNull();
  });

  it('TC-95-05 keeps the largest amount exact in the comparison and the text', () => {
    const max = String(MONEY_MAX);
    expect(atAge(HOUR, { amount: max })?.explanation).toBe(
      'Tài khoản mở 1 giờ trước, chuyển 9.223.372.036.854.775.807đ',
    );
    const justBelow = withThresholds({
      ...goodThresholds,
      minAmountExclusive: '9223372036854775806',
    });
    expect(atAge(HOUR, { amount: max }, justBelow)).not.toBeNull();
    const atMax = withThresholds({ ...goodThresholds, minAmountExclusive: max });
    expect(atAge(HOUR, { amount: max }, atMax)).toBeNull();
  });

  it.each([
    [0, 'dưới 1 phút'],
    [59_999, 'dưới 1 phút'],
    [MIN, '1 phút'],
    [45 * MIN, '45 phút'],
    [59 * MIN + 59_999, '59 phút'],
    [HOUR, '1 giờ'],
    [HOUR + 59 * MIN, '1 giờ'],
    [3 * HOUR, '3 giờ'],
    [23 * HOUR + 59 * MIN, '23 giờ'],
  ])('TC-95-06 describes an age of %i ms as "%s", rounded down', (ms, text) => {
    expect(atAge(ms)?.explanation).toBe(`Tài khoản mở ${text} trước, chuyển 20.000.000đ`);
  });

  it.each([
    ['10000001', '10.000.001đ'],
    ['999999999', '999.999.999đ'],
    ['100000000', '100.000.000đ'],
  ])('TC-95-06 groups the amount %s as %s', (amount, text) => {
    expect(atAge(HOUR, { amount })?.explanation).toBe(`Tài khoản mở 1 giờ trước, chuyển ${text}`);
  });

  it('TC-95-06 gives the same text whatever the process time zone or locale', () => {
    const saved = { TZ: process.env.TZ, LANG: process.env.LANG };
    try {
      const outputs = ['Asia/Ho_Chi_Minh', 'America/New_York', 'UTC'].map(zone => {
        process.env.TZ = zone;
        process.env.LANG = zone === 'UTC' ? 'en_US.UTF-8' : 'vi_VN.UTF-8';
        return atAge(3 * HOUR)?.explanation;
      });
      expect(new Set(outputs).size).toBe(1);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  const badTimes: unknown[] = [
    undefined,
    null,
    '',
    123,
    'not a date',
    '2026-10-19T03:15:42+00:00',
    '2026-02-30T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2100-02-29T00:00:00Z',
    '2026-10-19T24:00:00Z',
    '2026-10-19T03:15:60Z',
    '2026-10-19T03:15:42',
    '2026-10-19 03:15:42Z',
  ];

  it.each(badTimes)('TC-95-07 rejects fromAccountCreatedAt %p and names the field', value => {
    expect(() => run({ fromAccountCreatedAt: value })).toThrow(/fromAccountCreatedAt/);
  });

  it.each(badTimes)('TC-95-07 rejects occurredAt %p and names the field', value => {
    expect(() => run({ occurredAt: value })).toThrow(/occurredAt/);
  });

  it.each(['0', '', '-5', '007', 5, undefined])('TC-95-07 rejects amount %p', amount => {
    expect(() => run({ amount })).toThrow(/amount/);
  });

  it('TC-95-07 accepts real timestamps of any allowed shape', () => {
    expect(run({ fromAccountCreatedAt: '2024-02-29T00:00:00Z' })).toBeNull(); // leap day, old
    expect(atAge(0, { fromAccountCreatedAt: '2026-10-19T03:15:41.1Z' })).toMatchObject({
      id: 'R3',
    });
    const nineDigits = run({ fromAccountCreatedAt: '2026-10-19T03:15:41.123456789Z' });
    expect(nineDigits?.explanation).toContain('dưới 1 phút');
  });

  it('TC-95-07 reads the year 0099 as 99, not 1999', () => {
    const hit = run({
      occurredAt: '0100-01-01T00:00:00.000Z',
      fromAccountCreatedAt: '0099-12-31T12:00:00.000Z',
    });
    expect(hit?.explanation).toContain('12 giờ');
  });

  it('TC-95-07 treats a snapshot created after the transfer as age 0, still flagged', () => {
    expect(atAge(-1)?.explanation).toContain('dưới 1 phút');
    expect(atAge(0)?.explanation).toContain('dưới 1 phút');
    const far = run({ fromAccountCreatedAt: '9999-12-31T23:59:59Z' });
    expect(far?.explanation).toContain('dưới 1 phút');
  });

  it('TC-95-07 a disabled rule ignores a broken snapshot and amount', () => {
    const off = { ...v1, enabled: false };
    expect(run({ fromAccountCreatedAt: 'garbage', occurredAt: 5, amount: '0' }, off)).toBeNull();
  });

  it('TC-95-07 never echoes the offending input in the error message', () => {
    const secret = 'SECRET-123456';
    const attempts: (() => unknown)[] = [
      () => run({ fromAccountCreatedAt: secret }),
      () => run({ occurredAt: secret }),
      () => run({ amount: secret }),
      () => run({}, withThresholds({ ...goodThresholds, minAmountExclusive: secret })),
      () => run({}, withThresholds({ ...goodThresholds, maxAccountAgeHoursExclusive: secret })),
      () => run({}, { ...v1, weight: secret } as unknown as RuleParams),
    ];
    for (const attempt of attempts) {
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

  const badThresholds: unknown[] = [
    ...[0, -1, 1.5, NaN, Infinity, '24', 87601, null].map(maxAccountAgeHoursExclusive => ({
      ...goodThresholds,
      maxAccountAgeHoursExclusive,
    })),
    ...[10000000, '', '-1', '1e7', '007', '9223372036854775808', undefined, null].map(
      minAmountExclusive => ({ ...goodThresholds, minAmountExclusive }),
    ),
    { minAmountExclusive: '10000000' },
    { maxAccountAgeHoursExclusive: 24 },
    {},
    undefined,
    null,
  ];

  describe.each([true, false])('configuration is validated with enabled=%s', enabled => {
    it.each(badThresholds.map((thresholds, index) => [index, thresholds] as const))(
      'TC-95-08 rejects thresholds case %i',
      (_index, thresholds) => {
        expect(() => run({}, withThresholds(thresholds, { enabled }))).toThrow(Error);
      },
    );
    it.each([-1, 1.5, NaN, Infinity, 2147483648, '35'])('TC-95-08 rejects weight %p', weight => {
      expect(() => run({}, { ...v1, enabled, weight } as unknown as RuleParams)).toThrow(Error);
    });
    it('TC-95-08 accepts the seed configuration and the largest weight', () => {
      expect(() => run({}, { ...v1, enabled })).not.toThrow();
      expect(() => run({}, { ...v1, enabled, weight: 2147483647 })).not.toThrow();
    });
  });

  it('TC-95-08 rejects a non-boolean enabled', () => {
    expect(() => run({}, { ...v1, enabled: 'yes' } as unknown as RuleParams)).toThrow(Error);
  });

  it('TC-95-09 does not trigger when disabled', () => {
    expect(atAge(HOUR, { amount: '900000000' }, { ...v1, enabled: false })).toBeNull();
  });

  it('TC-95-09 uses the configured limits and weight instead of the seed', () => {
    const configured = withThresholds(
      { maxAccountAgeHoursExclusive: 48, minAmountExclusive: '5000000' },
      { weight: 10 },
    );
    expect(atAge(30 * HOUR, { amount: '6000000' }, configured)).toMatchObject({
      id: 'R3',
      weight: 10,
    });
    expect(atAge(30 * HOUR, { amount: '5000000' }, configured)).toBeNull();
    expect(atAge(48 * HOUR, { amount: '6000000' }, configured)).toBeNull();
  });

  it('TC-95-10 never scores a DEPOSIT, whatever the data looks like', () => {
    const deposit = { ...baseEvent, type: 'DEPOSIT' } as unknown as TransferEvent;
    expect(rule.evaluate(deposit, features, v1)).toBeNull();
    const broken = {
      ...deposit,
      fromAccountCreatedAt: 'garbage',
      amount: '0',
    };
    expect(rule.evaluate(broken, features, withThresholds(undefined))).toBeNull();
  });
});
