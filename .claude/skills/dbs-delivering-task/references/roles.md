# Role cards

Read the card of the task's assignee in Phase 1. Facts (schemas, signatures, numbers) live in the docs and code; these cards hold ownership and the traps already known. A task that spans roles keeps one owner; a change inside another role's module is a separate PR that the owner reviews.

| # | Role | Owns | Pair | Defense questions |
|---|---|---|---|---|
| 1 | Ledger | `modules/ledger`, review of every migration, `database-design.md` | #4 | 4, 5 |
| 2 | Accounts & Identity | `modules/identity`, `modules/accounts`, OpenAPI quality | #3 | 1, 3, 9 |
| 3 | Async & Audit | `modules/outbox`, `notification`, `audit`, event contract | #2 | 7 |
| 4 | Fraud | `modules/risk`, sync guard with #1 | #1 | 12 |
| 5 | Platform | `infra/`, `.github/workflows/`, Dockerfile, AWS account and cost | #6 | 8, 9, 11 |
| 6 | Quality | test harness, `load-tests/`, invariant script, dashboards, fraud dataset | #5 | 2, 6, 10 |

## #1 Ledger

Sources: docs/03 §6.1, ADR-04, 05, 07, 09, database-design.

- Order inside the transaction: `INSERT idempotency_keys … ON CONFLICT DO NOTHING` → `FOR UPDATE` both accounts **ordered by id** → guards **after** the lock (ACTIVE, per-transfer limit, day limit, balance) → transfer + exactly two ledger entries + balances + audit + outbox + stored response → commit → answer.
- **A rejection must commit.** Return an outcome from `TransactionService.run` and throw the 422 after it returns; throwing inside the callback rolls back the REJECTED row and its key.
- Retry already exists (`40P01`/`40001`, 3 times, then 503 + `Retry-After`). Never add a retry loop, never catch a DB error inside the callback (`25P02`), keep the callback re-entrant: no Redis, HTTP, SQS, no state surviving an attempt.
- Destination that does not exist = REJECTED `ACCOUNT_NOT_ACTIVE` with `to_account_id` NULL, same answer as a locked account.
- Day limit: DEBIT lines since midnight `Asia/Ho_Chi_Minh` in SQL on the index; "now" comes from an injectable clock so the midnight test is possible.
- Deposit = same flow, `type = DEPOSIT`, from the SYSTEM `funding` account, operator only.
- Review each migration against database-design §12; migrations run as a pipeline step, never at app start.
- Reconciliation runs in the `worker` role and is proven by corrupting a balance on purpose in a test.

## #2 Accounts & Identity

Sources: docs/03 §6.2, §7, §12, ADR-06, ADR-12.

- Request checks in order: verify the access token with cached JWKS (`iss`, `client_id`, `token_use = access`, `exp`; access tokens have no `aud`) → revocation mark → role guard → **ownership check in the service**.
- Roles come from `cognito:groups`; a token with no group is `customer`. Never read a role from body or headers.
- Another user's resource is **404**, and the denial is audited (`DENIED`) in its own transaction.
- A token whose `iat` is in the same second as `sessions_revoked_at` is rejected; the next second is accepted.
- Lock = one transaction (status, `sessions_revoked_at`, audit, outbox `AccountStatusChanged`); the Redis mark is written **after** commit. A Redis miss or error reads Postgres; it never means "not revoked".
- Account limit of 3: lock the `customers` row, then count, inside the opening transaction.
- Local and test auth: `AUTH_MODE=local`, rejected at startup in staging and production.
- Every endpoint's OpenAPI has role, examples and the `ErrorCode`s it can return; money fields are strings.

## #3 Async & Audit

Sources: docs/03 §10, §11, ADR-03, event-contract, database-design §4.6–4.9.

- Producers call `OutboxWriter.add(manager, event)` inside their own transaction; only the relay (worker) talks to SQS, and it is the one allowed exception to "no SQS in a transaction".
- Relay: lock unpublished rows (`SKIP LOCKED`), send to **every** routed queue, then set `published_at`; poll 500 ms, batch 100.
- One queue and one DLQ per consumer. Consumer: `processed_events(consumer, event_id)` in the same transaction as the effect; delete the message only after commit; a malformed message goes to the DLQ at once (the consumer sends it there itself); a known but unhandled type is acknowledged and skipped; a transient error is left for redelivery (DLQ after 5 receives).
- Consumers start only when `runsWorkers()`; they never rely on arrival order.
- `AuditService.record` runs in the caller's transaction and fails closed; holds ids and codes only, no PII.
- `correlationId` is server-generated and travels request → outbox → message → consumer → audit through `AsyncLocalStorage`.
- `TransferRejected` is not emitted in v1.

## #4 Fraud

Sources: FRAUD_DETECTION_GUIDE, risk/02-architecture, ADR-08, database-design §4.8.

- Two layers: the sync guard (inside the transfer transaction, after the lock, only the day-limit sum) and async scoring (worker, after commit, flags only). The system never blocks or locks on its own.
- Rules are pure functions `evaluate(event, features, params)`; a `FeatureProvider` (online: Redis + SQL; offline: memory) supplies features. The same rule code runs live and in evaluation.
- Time is the event's `occurredAt` (= `transfers.created_at`), never the worker clock. R3 and R6 use the snapshots in the event. Score only `TRANSFER`; `sameOwner` exempts R5 and R6.
- Redis is a cache of SQL: answer from SQL on a missing key, a cold key, or an error; trim by wall clock, not by `occurredAt`. Redis calls happen **before** the consumer's `BEGIN`. The SQL fallback reads `v_transfer_facts`, not `transfers`.
- Rule-set versions are immutable; a flag stores its version; an emergency switch is a new version.
- **Never open or search the fraud-dataset generator** (`load-tests/fraud-dataset/`); tune on the tune set only; freeze, then run the holdout exactly once; report per scenario, including the ones no rule targets.

## #5 Platform

Sources: docs/03 §12, §13, ADR-06, 10, 11, 12, `infra/terraform/README.md`.

- AWS `ap-southeast-1`, created and destroyed per session. Kept: state, ECR, VPC, Cognito, Secrets Manager, KMS, SQS, budgets. Per session: RDS, ElastiCache, ALB, ECS services, WAF.
- No NAT gateway, no interface endpoints: tasks in public subnets with a security group open only to the ALB; RDS and Valkey in private subnets.
- `terraform plan` is shown to the human; `apply` and `destroy` only with their go-ahead in this conversation. After `destroy`, check for leftovers by service (network interfaces and Elastic IPs do not show in a tag listing).
- Dev create-and-destroy traps: Secrets Manager keeps deleted names (use `recovery_window_in_days = 0` in dev or keep secrets in the kept stack); RDS `skip_final_snapshot = true`, `deletion_protection = false`; the ALB address changes every session.
- CI: lint, typecheck, unit, e2e (Testcontainers), one image, image and secret scan, push to ECR tagged by SHA over OIDC; deploy skips when the runtime stack is down; migration is its own step.
- An AWS deployment runs `NODE_ENV=staging` or `production`, which require TLS to Postgres (RDS CA bundle in the image) and Redis, `TRUST_PROXY_HOPS=1`, `AUTH_MODE=cognito`.

## #6 Quality

Sources: docs/02 §4, §5, docs/03 §14, §17, `load-tests/README.md`.

- The Testcontainers harness (Postgres, Valkey, ElasticMQ, production DB roles, one database per suite cloned from a migrated template) blocks every money test: build it first.
- `backend/test/support/invariants.sql` is the one invariant check (debits = credits, balances sum to 0, no customer balance below 0, balance = sum of entries), run after every money test and every load run.
- k6 runs from a machine in the same region, never a laptop; record the environment beside every result; log level `log` during runs.
- Failure injections and their expected outcome become the P4 incident table.
- You hold the fraud generator and the holdout labels; #4 and its agents never see the generator.
