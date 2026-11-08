## Findings

1. **Malformed runtime dates can be accepted through coercion.**  
   `toAiFeatureInput` calls `Date.parse` without first checking that the three date fields are strings. For example, an `occurredAt` value of `0` is coerced to `"0"`, which JavaScript parses as a finite date; an array containing a valid date string is also coerced and accepted. This applies to `occurredAt`, `fromAccountCreatedAt`, and non-null `reverseTransferOccurredAt`. Reject non-string values before parsing, and add runtime tests using casts from malformed values.

2. **The unexpected-field check does not cover all own properties.**  
   `Object.keys(record)` ignores symbol-keyed and non-enumerable properties. Thus a valid input with an additional non-enumerable `email` property passes despite the stated requirement to reject unexpected fields. The property is **not forwarded** in the returned payload, so this is a validation-contract issue, not a demonstrated payload leak. Use `Reflect.ownKeys` if all unexpected own properties must be rejected, and test both cases.

## Precision and test coverage

The twice-median conversion itself uses `BigInt` and checks the 20-character limit **before** conversion; the supplied boundary examples preserve exact precision through `2 * MONEY_MAX`.

The implementation of `parseMoney` is not shown, so it is not possible to verify statically whether a very long `medianAmount30d` passed directly to `projectFeatures` is rejected *before* a potentially expensive `BigInt` conversion. The same dependency limits review of the amount and balance parsers. Add direct long-string tests and inspect those parsers; an explicit median length bound before `parseMoney` would make that protection local.

Finally, `.toThrow('Invalid AI features')` checks for a matching message, not necessarily an **exact** message. Assert the exact error message to substantiate the no-input-leak guarantee.