# Fraud (#4): domain notes

The five phases and four gates apply to #4's tasks. This file holds what is specific to fraud. Truth: `docs/components/risk/FRAUD_DETECTION_GUIDE.md`, `docs/components/risk/02-architecture.md`, ADR-08, `database-design.md` §4.8 and §8.

## Two layers, do not mix them

| Layer | Where | Effect |
|---|---|---|
| Sync guard (status, limits, balance) | in the transfer transaction, after `FOR UPDATE`; code from the ledger tasks | `REJECTED` |
| Async scoring R1 to R6 | worker, after commit, from `TransferCompleted` | a flag only |

The system never blocks or locks an account on its own; only an operator does.

## Rules and scoring

- Rules are pure functions `evaluate(event, features, params)`; a `FeatureProvider` (online: Redis + SQL; offline: memory) supplies features. The same rule code runs live and in evaluation. Test that both providers return identical features for in-order, warm-cache input and say that is the scope of the parity.
- Time is the event's `occurredAt` (= `transfers.created_at`), never the worker clock. R3 and R6 use the snapshots in the event. Score only `TRANSFER`; `sameOwner` exempts R5 and R6.
- Redis is a cache of SQL, not a second truth. Answer from SQL on a missing or cold key, or on a Redis error; trim by wall clock, not by `occurredAt` (a later event processed first would delete members an earlier one still needs); record which path answered. Guide §5.4 was corrected to clean up by wall clock (FRAUD-API-01 baseline fix); keep it that way. Redis calls happen **before** the consumer's `BEGIN`.
- The SQL fallback reads `v_transfer_facts`, not `transfers`, and repeats `status = 'COMPLETED' AND type = 'TRANSFER'` to use the partial index.
- Idempotency twice: `processed_events` in the same transaction as the flag, and the flag's primary key. Counter sets use `transferId` as member.
- A rule-set version is immutable; a flag stores its version; an emergency switch is a new version with the rule disabled. One rule throwing must not stop the others; count it in a metric.
- Customers never see a flag (AC-10.2); explanations are Vietnamese, specific, with the numbers.

## Proposed: ADR-14 (rules plus hosted AI API), not accepted yet

Applies only when a task explicitly implements it and only after the team accepts ADR-14. Truth: `docs/adr/0014-fraud-rules-external-ai.md` and `docs/features/FRAUD-API-01-external-ai-decision.md` (§3.8 holds the proposed `risk_decisions` schema). It differs from the accepted design above in these points:

- One immutable `risk_decisions` row per TRANSFER in every mode. Claim `processed_events`, then `INSERT ... ON CONFLICT (transfer_id) DO NOTHING RETURNING transfer_id`; call the hosted API outside the SQL transaction, once per pass, never retried inside it.
- Three failure cases. A rule or feature-query fault rolls back, is not acked and goes to the DLQ after the retries (for the proposed design this replaces "one rule throwing must not stop the others"). An invalid `ai.*` block is rejected when the version is created; if one is read anyway it is stored as `CONFIG_INVALID` with weight 0 and the rules still score. A provider failure falls back to R1 to R6.
- `score = rule_score + ai_applied_weight`. AI only adds, hits stay R1 to R6, and a flag may have zero hits.
- Send only the allowlisted features. Never log the request body, the raw response or `Authorization` (use the DBS-42 logger).

## Evaluation discipline

- **Never open or search `load-tests/fraud-dataset/`** (use `--glob '!load-tests/fraud-dataset/**'`): it holds the generator source and the holdout labels, which the Dev who builds the dataset keeps until week 7. That Dev delivers the tune CSV (with labels) to `backend/data/fraud/` (gitignored, shared by link); that folder you may read. In week 7, after you freeze the configurations (DBS-168), that Dev delivers the holdout CSV to the same folder; before that it does not exist for you.
- Tune only on the tune set, recording each configuration version and its result.
- **Freeze every version, then run the holdout exactly once.** A second run turns it into a tune set. Do not pick the default version by holdout results.
- Report per scenario, including the ones no rule targets, as stated limits. Report precision, recall, F1, alerts per 1,000 transfers, ablation by rule and the precision–recall curve.
- Near-perfect numbers mean leakage or a bad split: investigate before reporting.

## Missing dependencies

`RedisClient`, `SqsClient`, `ConsumerBase`, the fraud migrations and `v_transfer_facts` may not exist yet. Reduced scope that is still useful: the pure rule and its tests, the offline provider, the SQL feature query against a migrated test database. Add Redis last.
