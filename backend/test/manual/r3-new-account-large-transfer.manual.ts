import assert from 'node:assert/strict';
import { MONEY_MAX } from '../../src/common/money';
import type { Features, TransferEvent } from '../../src/modules/risk/features/feature-provider';
import { R3NewAccountLargeTransferRule } from '../../src/modules/risk/rules/r3-new-account-large-transfer.rule';
import type { RuleParams } from '../../src/modules/risk/rules/rule';

const OCCURRED_AT = '2026-10-19T03:15:42.123Z';
const HOUR = 3_600_000;
const MIN = 60_000;
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
const features = {} as unknown as Features; // R3 reads only the event snapshot
const v1: RuleParams = {
  enabled: true,
  weight: 35,
  thresholds: { maxAccountAgeHoursExclusive: 24, minAmountExclusive: '10000000' },
};
const rule = new R3NewAccountLargeTransferRule();
const ageOf = (ms: number): string => new Date(Date.parse(OCCURRED_AT) - ms).toISOString();
const run = (fields: Record<string, unknown>, params: RuleParams = v1) =>
  rule.evaluate({ ...baseEvent, ...fields } as unknown as TransferEvent, features, params);

// M-95-01: a 3-hour-old account moves 20,000,000
const hit = run({});
assert.deepEqual(hit, {
  id: 'R3',
  weight: 35,
  explanation: 'Tài khoản mở 3 giờ trước, chuyển 20.000.000đ',
});
console.log(JSON.stringify({ case: 'M-95-01', result: hit }));

// M-95-02: exactly on both thresholds
const at24h = run({ fromAccountCreatedAt: ageOf(24 * HOUR) });
const atAmount = run({ fromAccountCreatedAt: ageOf(HOUR), amount: '10000000' });
assert.equal(at24h, null);
assert.equal(atAmount, null);
console.log(JSON.stringify({ case: 'M-95-02', exactly24Hours: at24h, exactly10000000: atAmount }));

// M-95-03: one step past each threshold
const justYounger = run({ fromAccountCreatedAt: ageOf(24 * HOUR - 1) });
const justLarger = run({ fromAccountCreatedAt: ageOf(HOUR), amount: '10000001' });
assert(justYounger);
assert(justLarger);
console.log(
  JSON.stringify({ case: 'M-95-03', oneMsYounger: justYounger, oneDongLarger: justLarger }),
);

// M-95-04: only one condition holds
const oldAccount = run({ fromAccountCreatedAt: ageOf(30 * 24 * HOUR), amount: '1000000000' });
const smallAmount = run({ fromAccountCreatedAt: ageOf(MIN), amount: '1000000' });
assert.equal(oldAccount, null);
assert.equal(smallAmount, null);
console.log(
  JSON.stringify({
    case: 'M-95-04',
    oldAccountBigAmount: oldAccount,
    newAccountSmallAmount: smallAmount,
  }),
);

// M-95-05: the largest amount stays exact
const largest = run({ fromAccountCreatedAt: ageOf(HOUR), amount: String(MONEY_MAX) });
assert.equal(largest?.explanation, 'Tài khoản mở 1 giờ trước, chuyển 9.223.372.036.854.775.807đ');
console.log(JSON.stringify({ case: 'M-95-05', result: largest }));

// M-95-06: a missing snapshot field and a bad amount are explicit errors
const errors: string[] = [];
for (const fields of [{ fromAccountCreatedAt: undefined }, { amount: '0' }]) {
  assert.throws(
    () => run(fields),
    (error: Error) => {
      errors.push(error.message);
      return true;
    },
  );
}
assert.deepEqual(errors, [
  'Invalid R3 snapshot field: fromAccountCreatedAt',
  'Invalid R3 snapshot field: amount',
]);
console.log(JSON.stringify({ case: 'M-95-06', errors }));

// M-95-07: rule disabled; a DEPOSIT
const disabled = run({}, { ...v1, enabled: false });
const deposit = run({ type: 'DEPOSIT' });
assert.equal(disabled, null);
assert.equal(deposit, null);
console.log(JSON.stringify({ case: 'M-95-07', disabled, deposit }));

// M-95-08: minutes wording, and a snapshot created after the transfer counts as age 0
const minutes = run({ fromAccountCreatedAt: ageOf(45 * MIN) });
const future = run({ fromAccountCreatedAt: ageOf(-1) });
assert.equal(minutes?.explanation, 'Tài khoản mở 45 phút trước, chuyển 20.000.000đ');
assert.equal(future?.explanation, 'Tài khoản mở dưới 1 phút trước, chuyển 20.000.000đ');
console.log(
  JSON.stringify({ case: 'M-95-08', fortyFiveMinutes: minutes, createdAfterTransfer: future }),
);
