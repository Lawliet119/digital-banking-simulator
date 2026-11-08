## Findings

1. **R4 silently accepts a reverse timestamp outside its required interval.**  
   With `occurredAt = 2025-01-01T12:00:00Z`, a 60-minute window, and `reverseTransferOccurredAt = 2025-01-01T12:00:01Z`, R4 returns `null` rather than rejecting the invalid fact. It does the same for a timestamp before `11:00:00Z`. A non-null reverse timestamp is required to be in `[t-60m, t)`. Treating a contradictory provider fact as “no hit” can suppress the round-trip score if malformed facts reach scoring. By contrast, an in-range timestamp outside a *narrower configured window* can legitimately produce no hit.

   The AI projection compounds the future-timestamp case: it clamps the negative elapsed time to zero, so the same invalid fact is presented to AI as a just-occurring reverse transfer rather than rejected.

2. **AI projection loses valid sub-millisecond timestamp precision.**  
   For `occurredAt = 2025-01-01T12:00:00.000000001Z` and `reverseTransferOccurredAt = 2025-01-01T12:00:00.000000000Z`, R4 correctly sees a reverse transfer one nanosecond earlier. `toAiFeatureInput`, however, uses `Date.parse` for both timestamps and reports `minutesSinceReverse: 0`. Account age is similarly truncated to milliseconds. Thus the rule and AI paths can receive materially different temporal facts; a valid AI assessment based on the altered facts can add the fixed AI weight.
