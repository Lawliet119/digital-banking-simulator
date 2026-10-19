import {
  ACCOUNT_LOCKED_SAMPLE,
  DEPOSIT_SAMPLE,
  TRANSFER_SAMPLE,
} from '../../../test/support/event-samples';
import { accountStatusChangedSchema, transferCompletedSchema } from './event-schemas';

/** The field names a `joi` object schema knows. */
const fieldsOf = (schema: { describe(): unknown }): string[] =>
  Object.keys((schema.describe() as { keys?: Record<string, unknown> }).keys ?? {}).sort();

describe('event schemas (DBS-24)', () => {
  it('TC-24-20 each schema knows exactly the fields of its event, as the typed samples have them', () => {
    // The samples are typed `TransferCompleted` / `AccountStatusChanged`, so they hold EVERY field
    // of the type. If a field is added to a type and to the samples but not to the schema (or the
    // reverse), the two lists below differ. The compile-time half is `satisfies Record<keyof T, …>`
    // in event-schemas.ts: `npm run typecheck` fails when a type and its schema disagree.
    expect(fieldsOf(transferCompletedSchema)).toEqual(Object.keys(TRANSFER_SAMPLE).sort());
    expect(fieldsOf(transferCompletedSchema)).toEqual(Object.keys(DEPOSIT_SAMPLE).sort());
    // `reason` is forbidden on AccountStatusChanged: it is in the schema, but not a field of the type.
    expect(fieldsOf(accountStatusChangedSchema).filter(key => key !== 'reason')).toEqual(
      Object.keys(ACCOUNT_LOCKED_SAMPLE).sort(),
    );
  });
});
