**One remaining defect: the date type checks and parsing read properties separately.**

An accessor or proxy can return a string during the type check and a non-string during the subsequent `Date.parse` call. For example, `event.occurredAt` could return an ISO string on its first read and an object whose `toString()` returns a different ISO date on its second read. The object is then accepted through `Date.parse` coercion, and the projected account age is calculated from the second date.

The same pattern affects `event.fromAccountCreatedAt` and `features.reverseTransferOccurredAt`; the latter is also read separately for its null check.

**Fix:** Read each date property once into a local variable, then perform the null/type checks and parse that same value. This preserves the intended rejection of non-string dates even for accessor-backed inputs.