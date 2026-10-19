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

  /** Values of the wrong JSON type for a field whose valid value is `value`. */
  function wrongTypesFor(key: string, value: unknown): unknown[] {
    if (typeof value === 'boolean') return ['true', 'false', 1, 0, null, {}];
    if (value === null) return [5, true, {}, []]; // fromUserId of a DEPOSIT: null is the valid value
    // `fromUserId: null` is a valid shape for the type check; the TRANSFER-needs-an-owner rule
    // is a cross-field rule (TC-24-11).
    const forString = [5, true, {}, ['x'], new Date(0)];
    return key === 'fromUserId' ? forString : [...forString, null];
  }

  describe.each(Object.entries(VALID_SAMPLES))(
    'TC-24-05 a wrong JSON type in the %s sample',
    (_name, sample) => {
      const keys = Object.keys(sample).filter(key => key !== 'eventType'); // eventType: TC-24-14
      it.each(keys)('%s gives exactly one WRONG_TYPE at that path', key => {
        const original = (sample as unknown as Record<string, unknown>)[key];
        for (const wrong of wrongTypesFor(key, original)) {
          const payload: Record<string, unknown> = { ...clone(sample), [key]: wrong };

          expect(pairsOf(payload)).toEqual([[key, 'WRONG_TYPE']]);
        }
      });
    },
  );

  it('TC-24-10 a value outside an enum is NOT_ALLOWED at that path, whatever its case', () => {
    for (const sample of [TRANSFER_SAMPLE, DEPOSIT_SAMPLE]) {
      for (const type of ['WITHDRAWAL', 'transfer', 'Deposit']) {
        expect(pairsOf({ ...clone(sample), type })).toEqual([['type', 'NOT_ALLOWED']]);
      }
    }
    for (const newStatus of ['FROZEN', 'active', 'locked', 'PENDING']) {
      expect(pairsOf({ ...clone(ACCOUNT_LOCKED_SAMPLE), newStatus })).toEqual([
        ['newStatus', 'NOT_ALLOWED'],
      ]);
    }
  });

  it('TC-24-16 reports every problem at once, one issue per path', () => {
    const payload = { ...clone(TRANSFER_SAMPLE), amount: 5, sameOwner: 'x', toUserId: null };

    expect(pairsOf(payload)).toEqual([
      ['amount', 'WRONG_TYPE'],
      ['sameOwner', 'WRONG_TYPE'],
      ['toUserId', 'WRONG_TYPE'],
    ]);
  });

  it('TC-24-23 a wrong TYPE on an enum field is WRONG_TYPE alone, never also NOT_ALLOWED', () => {
    // joi reports both `any.only` and `string.base` for these; the issue list folds them to one.
    for (const sample of [TRANSFER_SAMPLE, DEPOSIT_SAMPLE]) {
      for (const type of [5, null]) {
        expect(pairsOf({ ...clone(sample), type })).toEqual([['type', 'WRONG_TYPE']]);
      }
    }
    for (const newStatus of [5, null, true]) {
      expect(pairsOf({ ...clone(ACCOUNT_LOCKED_SAMPLE), newStatus })).toEqual([
        ['newStatus', 'WRONG_TYPE'],
      ]);
    }
  });

  // ── formats (step 4) ──────────────────────────────────────────────────────────────────────────

  const UUID_FIELDS: Record<keyof typeof VALID_SAMPLES, string[]> = {
    TRANSFER: [
      'eventId',
      'correlationId',
      'transferId',
      'fromAccountId',
      'toAccountId',
      'fromUserId',
      'toUserId',
    ],
    // fromUserId is null for a DEPOSIT: nothing to break
    DEPOSIT: ['eventId', 'correlationId', 'transferId', 'fromAccountId', 'toAccountId', 'toUserId'],
    ACCOUNT_LOCKED: ['eventId', 'correlationId', 'accountId', 'ownerUserId', 'changedByUserId'],
    ACCOUNT_ACTIVE: ['eventId', 'correlationId', 'accountId', 'ownerUserId', 'changedByUserId'],
  };

  const TIME_FIELDS: Record<keyof typeof VALID_SAMPLES, string[]> = {
    TRANSFER: ['occurredAt', 'fromAccountCreatedAt', 'toAccountCreatedAt'],
    DEPOSIT: ['occurredAt', 'fromAccountCreatedAt', 'toAccountCreatedAt'],
    ACCOUNT_LOCKED: ['occurredAt'],
    ACCOUNT_ACTIVE: ['occurredAt'],
  };

  const withField = (sample: object, key: string, value: unknown): Record<string, unknown> => ({
    ...clone(sample),
    [key]: value,
  });

  describe.each(Object.entries(VALID_SAMPLES))(
    'TC-24-06 a malformed uuid in the %s sample',
    (name, sample) => {
      it.each(UUID_FIELDS[name as keyof typeof VALID_SAMPLES])(
        '%s is INVALID_FORMAT, whatever the way it is malformed',
        key => {
          const valid = (sample as unknown as Record<string, string>)[key];
          const malformed = [
            'abc',
            '',
            valid.slice(0, -5), // a group too short
            valid.replace(/.$/, 'g'), // not hex
            `{${valid}}`, // braces
            valid.replaceAll('-', ''), // no hyphens
            `${valid} `, // trailing space
            `${valid}\n`, // trailing newline
            'x'.repeat(100_000), // must be refused at once, and never echoed
            ...(/[a-f]/.test(valid) ? [valid.toUpperCase()] : []), // upper case splits Redis keys
          ];
          for (const value of malformed) {
            const issues = issuesOf(withField(sample, key, value));

            expect(issues.map(i => [i.path, i.code])).toEqual([[key, 'INVALID_FORMAT']]);
            expect(issues[0].message).not.toContain('xxxx');
          }
        },
      );
    },
  );

  it('TC-24-06 the funding account id (no letters, version 4, variant 8) is a valid uuid', () => {
    expect(validateEvent(clone(DEPOSIT_SAMPLE)).ok).toBe(true);
  });

  it('TC-24-07 amount is a canonical decimal string above zero and within 2^63 - 1', () => {
    for (const amount of ['1', '500000', '9007199254740993', '9223372036854775807']) {
      expect(validateEvent(withField(TRANSFER_SAMPLE, 'amount', amount)).ok).toBe(true);
    }
    for (const amount of [
      '0',
      '-1',
      '1.5',
      '01',
      ' 1',
      '1e3',
      '',
      '9223372036854775808',
      '99999999999999999999',
    ]) {
      expect(pairsOf(withField(TRANSFER_SAMPLE, 'amount', amount))).toEqual([
        ['amount', 'INVALID_FORMAT'],
      ]);
    }
    // A JSON number is refused even when exact: by the time we see it the digits may be gone.
    expect(pairsOf(withField(TRANSFER_SAMPLE, 'amount', 500000))).toEqual([
      ['amount', 'WRONG_TYPE'],
    ]);
  });

  it('TC-24-08 fromBalanceBefore is a signed canonical decimal string, negative allowed', () => {
    for (const balance of [
      '-1000000',
      '0',
      '520000',
      '-9223372036854775808',
      '9223372036854775807',
    ]) {
      expect(validateEvent(withField(TRANSFER_SAMPLE, 'fromBalanceBefore', balance)).ok).toBe(true);
    }
    for (const balance of [
      '-0',
      '01',
      '1.5',
      '1e3',
      ' 1',
      '',
      '9223372036854775808',
      '-9223372036854775809',
    ]) {
      expect(pairsOf(withField(TRANSFER_SAMPLE, 'fromBalanceBefore', balance))).toEqual([
        ['fromBalanceBefore', 'INVALID_FORMAT'],
      ]);
    }
    expect(pairsOf(withField(TRANSFER_SAMPLE, 'fromBalanceBefore', -5))).toEqual([
      ['fromBalanceBefore', 'WRONG_TYPE'],
    ]);
  });

  describe.each(Object.entries(VALID_SAMPLES))(
    'TC-24-09 a time field of the %s sample is UTC with Z and a real date',
    (name, sample) => {
      const valid = [
        '2026-10-19T03:15:42Z',
        '2026-10-19T03:15:42.1Z',
        '2026-10-19T03:15:42.123Z',
        '2026-10-19T03:15:42.123456Z',
        '2026-10-19T03:15:42.123456789Z',
        '2026-12-31T23:59:59.999Z',
        '2028-02-29T00:00:00Z', // leap year
        '2000-02-29T12:00:00Z', // leap year, divisible by 400
        '0400-02-29T00:00:00Z', // leap, and a year below 100 must not be read as 19xx
      ];
      const invalid = [
        '2026-10-19T10:15:42+07:00', // an offset
        '2026-10-19T03:15:42+00:00', // even a zero offset: the contract says Z
        '2026-10-19T03:15:42', // no zone
        '2026-10-19', // date only
        '2026-10-19 03:15:42Z', // space instead of T
        '2026-10-19t03:15:42z', // lower case
        '2026-10-19T03:15:42.Z', // empty fraction
        '2026-10-19T03:15:42.1234567890Z', // ten fraction digits
        '2026-10-19T03:15:42ZZ',
        ' 2026-10-19T03:15:42Z',
        '2026-02-30T00:00:00Z', // V8 would roll this to 2 March
        '2026-02-29T00:00:00Z', // not a leap year
        '2100-02-29T00:00:00Z', // divisible by 100, not by 400
        '0100-02-29T00:00:00Z', // same, in a year below 100
        '2026-04-31T00:00:00Z',
        '2026-13-01T00:00:00Z',
        '2026-00-10T00:00:00Z',
        '2026-10-00T00:00:00Z',
        '2026-10-32T00:00:00Z',
        '2026-10-17T24:00:00Z', // V8 would roll this to the next day
        '2026-10-17T10:60:00Z',
        '2026-10-17T10:00:60Z',
      ];

      it.each(TIME_FIELDS[name as keyof typeof VALID_SAMPLES])('%s', key => {
        for (const time of valid) expect(validateEvent(withField(sample, key, time)).ok).toBe(true);
        for (const time of invalid) {
          expect(pairsOf(withField(sample, key, time))).toEqual([[key, 'INVALID_FORMAT']]);
        }
        // An epoch number or a Date object is the wrong TYPE, not a bad format.
        for (const wrong of [1_760_843_742_000, new Date(0)]) {
          expect(pairsOf(withField(sample, key, wrong))).toEqual([[key, 'WRONG_TYPE']]);
        }
      });
    },
  );
});
