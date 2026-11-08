## Findings

### Medium — Throwing AI properties bypass baseline fallback
**Path:** `scoring.service.ts`, `score()` AI configuration and assessment handling

The AI branch reads properties without guarding against accessors or proxies that throw. Because those reads occur after the baseline is computed but before it is returned, a malformed AI input can make scoring throw instead of falling back to the baseline, contrary to ADR-14.

For example, using the test fixtures and a valid `withAi` configuration:

```ts
const badAssessment = {
  get status() { throw new Error('bad AI response'); },
} as unknown as AiAssessment;

service.score(event, facts, withAi, badAssessment); // throws
```

Similarly, `config.ai` or its `threshold`/`weight` properties can be throwing getters. The existing malformed-input tests cover plain values, but not property-access failures. Guard AI-only reads and validation so an AI fault returns the already-computed baseline with an appropriate failure status. Baseline exceptions should still propagate.

### Low — Metric-name collision can prevent the scoring module from loading
**Path:** `scoring.service.ts`, module-level `risk_unsupported_mode_total` initialization

If the default registry already contains a metric named `risk_unsupported_mode_total` that is not an instance of this imported `Counter`, the code attempts to register another metric with the same name. `prom-client` rejects duplicate names, so importing the scoring module can fail before any scoring attempt.

For example, if another component registers a `Gauge` under that name before this module is loaded, the `instanceof Counter` check fails and the subsequent `new Counter(...)` attempts duplicate registration. A second installed copy of `prom-client` can also make an otherwise compatible counter fail the `instanceof` check.

This is a deployment/initialization failure rather than an incorrect score. The unsupported-mode test covers increments with the normal registry setup, not a pre-existing incompatible metric.

## Review limits

The rule implementations are not included, so their validation, threshold comparisons, and handling of malformed features cannot be verified from this excerpt. The shown service and tests explicitly cover the requested ordinary threshold boundaries, AI probability type checks, unsupported-mode counting, and baseline versus applied-AI overflow. Idempotency and privacy are not findings here because ADR-14 assigns them to future worker scope.