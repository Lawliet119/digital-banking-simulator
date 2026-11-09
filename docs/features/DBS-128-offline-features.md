# DBS-128 — Offline fraud features

## Contract

`OfflineFeatureProvider` implements the existing asynchronous `FeatureProvider` contract on a supplied, immutable snapshot of **completed TRANSFER** facts. The caller must supply all available historical facts, including earlier rows needed for the 30-day novelty and median windows; this provider does not read the labelled dataset, invent missing history, train a model or call an external API. Duplicate identical transfer IDs are deduplicated; conflicting IDs and events that do not match their fact are rejected.

The event-time windows, millisecond truncation, same-millisecond exclusions for historical data, bigint totals and doubled median follow `TransferFacts` SQL semantics. `extractAiInput` applies the same eleven-field allowlist as the online mapper. Ordering input facts and extraction requests differently does not change the indexed snapshot. The index uses per-account sliding windows, pair indexes and bigint order statistics rather than a quadratic scan.

## Verification

On 2026-11-09, the offline unit and risk-contract suites passed 8/8. A synthetic PostgreSQL parity test passed across 80 facts, reversed extraction order, sub-millisecond timestamps and time-window boundaries. A separate regression reproduced an epoch-boundary truncation error (2 rather than 1) and passed after correction. The synthetic local 100,000-transfer manual run indexed in about 1.78 s and extracted/projected in about 3.32 s (approximately 269 MB observed Node heap); these are one-run workstation observations, not production throughput or accuracy claims.

```sh
cd backend
npm test -- --runInBand src/modules/risk/features/offline-feature-provider.spec.ts src/modules/risk/risk.contract.spec.ts
npm run test:db -- --runInBand --runTestsByPath test/db/offline-features.db-spec.ts
npx ts-node -r tsconfig-paths/register test/manual/offline-features.manual.ts
```

## Boundaries

Parity is relative to the same completed fact set and event-time semantics; it does not establish online multi-query snapshot isolation. A deliberately generated 100k smoke is not the team tune/holdout dataset and has no fraud labels. No precision, recall or model efficacy claim follows from these tests. Dataset delivery, independent holdout, external-provider authorization and production load validation remain separate work.
