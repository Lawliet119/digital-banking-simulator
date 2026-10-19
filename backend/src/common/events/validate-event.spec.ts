import { runInNewContext } from 'node:vm';
import {
  ACCOUNT_ACTIVE_SAMPLE,
  ACCOUNT_LOCKED_SAMPLE,
  DEPOSIT_SAMPLE,
  TRANSFER_SAMPLE,
  VALID_SAMPLES,
} from '../../../test/support/event-samples';
import { validateEvent, type EventIssue, type EventIssueCode } from './validate-event';

/** What a failed validation says, sorted by path so a test never depends on the order of issues. */
function issuesOf(payload: unknown): EventIssue[] {
  const result = validateEvent(payload);
  return result.ok ? [] : [...result.issues].sort((a, b) => a.path.localeCompare(b.path));
}

/** The `(path, code)` pairs only: the message text is not part of the contract. */
function pairsOf(payload: unknown): [string, EventIssueCode][] {
  return issuesOf(payload).map(i => [i.path, i.code]);
}

const clone = <T>(value: T): T => structuredClone(value);

describe('validateEvent (DBS-24)', () => {
  it('TC-24-01 accepts a valid TRANSFER and hands back the very same object, untouched', () => {
    const payload = clone(TRANSFER_SAMPLE);
    const result = validateEvent(payload);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event).toBe(payload);
    expect(payload).toEqual(TRANSFER_SAMPLE);
  });

  it('TC-24-02 accepts a valid DEPOSIT: no owner on the source, a negative funding balance', () => {
    const result = validateEvent(clone(DEPOSIT_SAMPLE));

    expect(result.ok).toBe(true);
    expect(DEPOSIT_SAMPLE.fromUserId).toBeNull();
    expect(DEPOSIT_SAMPLE.fromBalanceBefore.startsWith('-')).toBe(true);
  });

  it('TC-24-03 accepts AccountStatusChanged for both ACTIVE and LOCKED', () => {
    expect(validateEvent(clone(ACCOUNT_LOCKED_SAMPLE)).ok).toBe(true);
    expect(validateEvent(clone(ACCOUNT_ACTIVE_SAMPLE)).ok).toBe(true);
  });

  describe.each(Object.entries(VALID_SAMPLES))(
    'TC-24-04 a missing field in the %s sample',
    (_name, sample) => {
      it.each(Object.keys(sample))('%s gives exactly one MISSING_FIELD at that path', key => {
        const payload: Record<string, unknown> = { ...clone(sample) };
        delete payload[key];

        expect(pairsOf(payload)).toEqual([[key, 'MISSING_FIELD']]);
      });
    },
  );

  it('TC-24-12 keeps fields it does not know, so an older consumer survives an additive change', () => {
    for (const sample of Object.values(VALID_SAMPLES)) {
      const payload = { ...clone(sample), riskScore: 7, futureField: { nested: true } };
      const result = validateEvent(payload);

      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.event).toMatchObject({ riskScore: 7, futureField: { nested: true } });
    }
  });

  it('TC-24-14 the envelope: eventType missing, of the wrong type, or unknown, is one issue at eventType', () => {
    const base: Record<string, unknown> = { ...clone(TRANSFER_SAMPLE) };
    const withEventType = (value: unknown): Record<string, unknown> => ({
      ...base,
      eventType: value,
    });
    const withoutEventType = { ...base };
    delete withoutEventType.eventType;

    expect(pairsOf(withoutEventType)).toEqual([['eventType', 'MISSING_FIELD']]);
    for (const wrong of [5, null, {}, true, ['TransferCompleted']]) {
      expect(pairsOf(withEventType(wrong))).toEqual([['eventType', 'WRONG_TYPE']]);
    }
    for (const unknown of ['FraudFlagRaised', 'transfercompleted', 'TransferRejected', '']) {
      expect(pairsOf(withEventType(unknown))).toEqual([['eventType', 'UNKNOWN_EVENT_TYPE']]);
    }
  });

  it('TC-24-15 anything that is not a plain object is one NOT_AN_OBJECT at the root', () => {
    class Impostor {
      eventType = 'TransferCompleted';
    }
    const notObjects: unknown[] = [
      null,
      undefined,
      JSON.stringify(TRANSFER_SAMPLE), // the raw SQS body: the adapter must JSON.parse first
      42,
      true,
      [],
      [TRANSFER_SAMPLE],
      new Date(),
      new Map(),
      new Impostor(),
    ];
    for (const payload of notObjects) {
      expect(pairsOf(payload)).toEqual([['', 'NOT_AN_OBJECT']]);
    }
    // An object made in another realm (a vm context, a worker, Jest's own sandbox for
    // structuredClone) has a different Object.prototype, but it is still a plain object.
    const foreign = runInNewContext(`(${JSON.stringify(TRANSFER_SAMPLE)})`) as unknown;
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    expect(validateEvent(foreign).ok).toBe(true);
    // A payload from JSON.parse is a plain object; so is one with no prototype at all.
    expect(validateEvent(Object.assign(Object.create(null) as object, TRANSFER_SAMPLE)).ok).toBe(
      true,
    );
  });
});
