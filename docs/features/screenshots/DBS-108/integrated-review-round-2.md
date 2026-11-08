## Finding: R2 parses an unbounded median string before checking its range

**Report, rather than approve.** In `R2UnusualAmountRule`, `medianAmount30dTimes2` is checked against a digit-only regex and then converted to `BigInt` *before* the maximum is checked. A malformed feature containing millions of digits can therefore consume substantial CPU and memory even though it must ultimately be rejected. The AI projection already prevents this with a 20-character limit.

Repro against R2 directly, using otherwise valid event and rule fixtures:

```ts
const features = {
  ...validFeatures,
  historyCount30d: 5,
  medianAmount30dTimes2: '9'.repeat(1_000_000),
};

rule.evaluate(validTransferEvent, features, {
  enabled: true,
  weight: 1,
  thresholds: {
    historyDays: 30,
    minHistory: 5,
    medianMultiplier: 2,
  },
});
```

The call attempts `BigInt(raw)` on the entire million-digit string before throwing for exceeding `MEDIAN_TIMES2_MAX`. This is a resource-exhaustion risk if malformed or untrusted feature data can reach scoring; the supplied code alone does not establish that exposure. I have not executed this repro.

**Fix:** reject strings longer than `MEDIAN_TIMES2_MAX.toString().length` before regex matching and conversion, then retain the existing numeric bounds check. Add a test for an oversized digit string.

I have not reopened the R4 window behavior or provider-provenance issues, per the stated contract.
