**Request changes before approval.** The nanosecond arithmetic is sound, but the proposed parser does not fully enforce the stated timestamp contract, and the R3/R1 integrations are not shown.

### Issue: timestamp regex accepts a trailing line terminator

JavaScript’s `$` can match immediately before a final line terminator. Consequently, `riskTimeNanoseconds('2026-01-01T00:00:00Z\n')` is accepted even though it is not a contract timestamp. The calendar round-trip check doesn’t catch it because it compares only the first 19 characters.

Use a true end-of-input assertion, such as replacing the final `$` with `(?![\s\S])`. The existing R3 regex has the same weakness, so fixing it is contract enforcement rather than a new regression—but sharing the proposed parser would also carry the weakness into R1.

### Arithmetic and compatibility checks

- Parsing whole seconds into milliseconds, converting to `bigint`, then adding the padded fraction preserves all nine digits, including for instants before the Unix epoch. The round-trip check rejects normalized invalid dates and hour 24.
- Compute the difference as `bigint` and clamp **after subtraction**: `age = occurredAt > createdAt ? occurredAt - createdAt : 0n`. Compare it against `BigInt(maxAgeHours) * 3_600_000_000_000n`.
- On a hit, `Number(age / 1_000_000n)` is safe: the exclusive maximum is 87,600 hours, or 315,360,000,000 milliseconds, well below `Number.MAX_SAFE_INTEGER`. Flooring to milliseconds also preserves the existing whole-minute/hour `formatAge` output.
- Nanosecond-accurate comparison can change results near an exclusive threshold relative to the old millisecond-truncated implementation. That is the intended precision correction, but it is observable behavior.
- Wrap parser failures at each R3 call site to retain the respective `occurredAt` and `fromAccountCreatedAt` errors. Preserve the existing ordering: the non-transfer guard comes first, configuration validation precedes the disabled return, and disabled transfers do not inspect event fields.

### Integration to verify

Place the shared parser and its `UTC_TIME` in a common module imported by both rules; as presented, the two `UTC_TIME` declarations would conflict if placed in the same module. Also verify R1’s unit conversions, boundary semantics, and error mapping when adopting the bigint parser. Its reference-window implementation is not shown, so those effects cannot be approved from this excerpt. Ensure the TypeScript target/runtime supports bigint literals.
