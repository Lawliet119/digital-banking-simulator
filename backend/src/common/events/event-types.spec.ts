import {
  ACCOUNT_LOCKED_SAMPLE,
  DEPOSIT_SAMPLE,
  TRANSFER_SAMPLE,
} from '../../../test/support/event-samples';
import {
  EVENT_TYPES,
  type AccountStatusChanged,
  type DomainEvent,
  type EventType,
  type TransferCompleted,
} from './event-types';

/** The id of the thing the event is about; compiles only if `eventType` narrows the union. */
function subjectOf(event: DomainEvent): string {
  switch (event.eventType) {
    case 'TransferCompleted':
      return event.transferId;
    case 'AccountStatusChanged':
      return event.accountId;
    default: {
      // Adding a third event type to DomainEvent without handling it here makes this line fail.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

describe('event types (DBS-24)', () => {
  it('TC-24-19 the compiler enforces the contract of both events', () => {
    // Nothing here runs. Every `@ts-expect-error` line must be a compile error: if the types were
    // loosened, the directive would be unused and `npm run typecheck` / ts-jest would fail. Each
    // case is one line, so the error lands on the line the directive sits above.
    const _typeChecks = (): void => {
      const { amount: _amount, ...withoutAmount } = TRANSFER_SAMPLE;

      // @ts-expect-error -- a required field (amount) is missing
      const _m1: TransferCompleted = withoutAmount;
      // @ts-expect-error -- amount is a string on the wire, never a number
      const _m2: TransferCompleted = { ...TRANSFER_SAMPLE, amount: 500000 };
      // @ts-expect-error -- a DEPOSIT has no owner on the source account: fromUserId must be null
      const _m3: TransferCompleted = { ...DEPOSIT_SAMPLE, fromUserId: 'b2e5c8a1' };
      // @ts-expect-error -- a TRANSFER needs the sender's user id, not null
      const _m4: TransferCompleted = { ...TRANSFER_SAMPLE, fromUserId: null };
      // @ts-expect-error -- a DEPOSIT is never between two accounts of one owner
      const _m5: TransferCompleted = { ...DEPOSIT_SAMPLE, sameOwner: true };
      // @ts-expect-error -- "Other" is not an event type
      const _m6: DomainEvent = { ...TRANSFER_SAMPLE, eventType: 'Other' };
      // @ts-expect-error -- a TransferCompleted cannot carry the other event's type
      const _m7: TransferCompleted = { ...TRANSFER_SAMPLE, eventType: 'AccountStatusChanged' };
      // @ts-expect-error -- FROZEN is not an account status
      const _m8: AccountStatusChanged = { ...ACCOUNT_LOCKED_SAMPLE, newStatus: 'FROZEN' };

      // What IS allowed: `type` narrows the DEPOSIT branch, so fromUserId is exactly null there.
      if (DEPOSIT_SAMPLE.type === 'DEPOSIT') {
        const _owner: null = DEPOSIT_SAMPLE.fromUserId;
        const _same: false = DEPOSIT_SAMPLE.sameOwner;
      }
    };
    expect(typeof _typeChecks).toBe('function');
  });

  it('TC-24-19 eventType narrows the union at run time as well as at build time', () => {
    expect(subjectOf(TRANSFER_SAMPLE)).toBe(TRANSFER_SAMPLE.transferId);
    expect(subjectOf(ACCOUNT_LOCKED_SAMPLE)).toBe(ACCOUNT_LOCKED_SAMPLE.accountId);
  });

  it('TC-24-19 EVENT_TYPES lists exactly the event types of DomainEvent', () => {
    const names: EventType[] = Object.values(EVENT_TYPES);
    expect(names.sort()).toEqual(['AccountStatusChanged', 'TransferCompleted']);
    for (const [key, value] of Object.entries(EVENT_TYPES)) expect(key).toBe(value);
  });
});
