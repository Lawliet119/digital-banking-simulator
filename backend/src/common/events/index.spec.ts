import * as viaIndex from './index';
import * as viaAlias from '@common/events';
import type {
  AccountStatusChanged,
  DomainEvent,
  EventIssue,
  EventIssueCode,
  EventType,
  EventValidation,
  TransferCompleted,
} from '@common/events';

describe('@common/events public index (DBS-24)', () => {
  it('TC-24-21 exports the validator, the error, the event names and nothing else at run time', () => {
    // No schema and no `joi` object leaves the folder: callers go through `validateEvent`.
    expect(Object.keys(viaIndex).sort()).toEqual([
      'EVENT_TYPES',
      'InvalidEventError',
      'assertEvent',
      'validateEvent',
    ]);
    expect(typeof viaIndex.validateEvent).toBe('function');
    expect(typeof viaIndex.assertEvent).toBe('function');
    expect(typeof viaIndex.InvalidEventError).toBe('function');
    expect(viaIndex.EVENT_TYPES.TransferCompleted).toBe('TransferCompleted');
  });

  it('TC-24-21 the `@common/events` alias resolves to the same module', () => {
    expect(viaAlias.validateEvent).toBe(viaIndex.validateEvent);
    expect(viaAlias.assertEvent).toBe(viaIndex.assertEvent);
  });

  it('TC-24-21 every public type is importable from the index', () => {
    // Compile-time only: if one of these were not exported, ts-jest and `typecheck` would fail.
    const _types = (): [
      TransferCompleted?,
      AccountStatusChanged?,
      DomainEvent?,
      EventType?,
      EventIssue?,
      EventIssueCode?,
      EventValidation?,
    ] => [];
    expect(typeof _types).toBe('function');
  });
});
