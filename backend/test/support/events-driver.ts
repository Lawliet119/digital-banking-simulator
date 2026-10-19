/**
 * Manual-test driver for @common/events (DBS-24 §5). Run from backend/, in Git Bash:
 *
 *   npx ts-node -r tsconfig-paths/register test/support/events-driver.ts
 *
 * It feeds valid and broken events through the real `validateEvent` and prints what it decided:
 * `ok: true`, or `ok: false` with the (path, code) of every issue. Nothing here touches a database
 * or a queue; it lives under test/, so `nest build` never ships it.
 */
import { validateEvent } from '@common/events';
import {
  ACCOUNT_ACTIVE_SAMPLE,
  ACCOUNT_LOCKED_SAMPLE,
  DEPOSIT_SAMPLE,
  TRANSFER_SAMPLE,
} from './event-samples';

const clone = <T>(value: T): T => structuredClone(value);

/** What the wire does to an event: serialize, then parse. */
const overTheWire = (event: unknown): unknown => JSON.parse(JSON.stringify(event));

function show(label: string, payload: unknown): void {
  const result = validateEvent(payload);
  const verdict = result.ok
    ? 'ok: true'
    : `ok: false  ${result.issues.map(i => `${i.path || '(payload)'}:${i.code}`).join(', ')}`;
  console.log(`${label.padEnd(46)} ${verdict}`);
}

function without(sample: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...clone(sample) };
  delete copy[key];
  return copy;
}

const with_ = (sample: object, changes: Record<string, unknown>): Record<string, unknown> => ({
  ...clone(sample),
  ...changes,
});

console.log('=== M-24-01: valid events, as built and after a trip over the wire (JSON) ===');
const valid: [string, object][] = [
  ['TRANSFER', TRANSFER_SAMPLE],
  ['DEPOSIT (fromUserId null, funding at -1000000)', DEPOSIT_SAMPLE],
  ['AccountStatusChanged LOCKED', ACCOUNT_LOCKED_SAMPLE],
  ['AccountStatusChanged ACTIVE', ACCOUNT_ACTIVE_SAMPLE],
];
for (const [label, sample] of valid) {
  show(label, clone(sample));
  show(`${label} (over the wire)`, overTheWire(sample));
}
const big = with_(TRANSFER_SAMPLE, { amount: '9007199254740993' });
const bigAfterWire = overTheWire(big) as { amount: string };
show('TRANSFER amount 9007199254740993 (2^53 + 1)', big);
console.log(
  `  amount after the wire: ${bigAfterWire.amount}  same digits: ${bigAfterWire.amount === '9007199254740993'}`,
);

console.log('\n=== M-24-02: broken events, every issue listed (path:code) ===');
const rejected: [string, unknown][] = [
  ['TRANSFER without amount', without(TRANSFER_SAMPLE, 'amount')],
  ['amount is the JSON number 500000', with_(TRANSFER_SAMPLE, { amount: 500000 })],
  ['amount "01"', with_(TRANSFER_SAMPLE, { amount: '01' })],
  ['amount "0"', with_(TRANSFER_SAMPLE, { amount: '0' })],
  ['occurredAt with +07:00', with_(TRANSFER_SAMPLE, { occurredAt: '2026-10-19T10:15:42+07:00' })],
  [
    'occurredAt 2026-02-30 (not a real day)',
    with_(TRANSFER_SAMPLE, { occurredAt: '2026-02-30T00:00:00Z' }),
  ],
  [
    'eventId in upper case',
    with_(TRANSFER_SAMPLE, { eventId: String(TRANSFER_SAMPLE.eventId).toUpperCase() }),
  ],
  ['eventType "FraudFlagRaised"', with_(TRANSFER_SAMPLE, { eventType: 'FraudFlagRaised' })],
  ['type is the number 5', with_(DEPOSIT_SAMPLE, { type: 5 })],
  ['type "WITHDRAWAL"', with_(TRANSFER_SAMPLE, { type: 'WITHDRAWAL' })],
  [
    'DEPOSIT with an owner (fromUserId)',
    with_(DEPOSIT_SAMPLE, { fromUserId: TRANSFER_SAMPLE.eventId }),
  ],
  ['TRANSFER with fromUserId null', with_(TRANSFER_SAMPLE, { fromUserId: null })],
  ['newStatus "FROZEN"', with_(ACCOUNT_LOCKED_SAMPLE, { newStatus: 'FROZEN' })],
  ['three problems at once', with_(TRANSFER_SAMPLE, { amount: 5, sameOwner: 'x', toUserId: null })],
  ['raw JSON text instead of an object', JSON.stringify(TRANSFER_SAMPLE)],
  ['null', null],
  ['a Date', new Date(0)],
];
for (const [label, payload] of rejected) show(label, payload);

console.log('\n=== M-24-03: forward compatibility, and the one forbidden field ===');
const extended = with_(TRANSFER_SAMPLE, { riskScore: 7 });
show('TRANSFER plus an unknown field riskScore', extended);
const kept = validateEvent(extended);
console.log(
  `  riskScore kept in the result: ${kept.ok && (kept.event as unknown as { riskScore?: number }).riskScore === 7}`,
);
show('AccountStatusChanged with a reason', with_(ACCOUNT_LOCKED_SAMPLE, { reason: 'fraud' }));
