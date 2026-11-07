# Module notes: traps already known

Any developer may meet any module. Facts (schemas, signatures, numbers) live in the docs and the code; this file holds only the traps. Read the module's section before Phase 2.

## Ledger (transfer, deposit, guards, reconciliation)

Sources: docs/03 §6.1, ADR-04, 05, 09, database-design.

- Order inside the transaction: `INSERT idempotency_keys … ON CONFLICT DO NOTHING` → `FOR UPDATE` both accounts **ordered by id** → guards **after** the lock (ACTIVE, per-transfer limit, day limit, balance) → transfer + exactly two ledger entries + balances + audit + outbox + stored response → commit → answer. Guards before the lock let two parallel requests both pass.
- **A rejection must commit.** Return an outcome from `TransactionService.run` and throw the 422 after it returns; throwing inside the callback rolls back the REJECTED row and its key.
- Retry already exists (`40P01`/`40001`, 3 times, then 503 + `Retry-After`). Never add a retry loop; never catch a DB error inside the callback (the next statement fails with `25P02`); keep the callback re-entrant: no Redis, HTTP, SQS, no state surviving an attempt.
- A destination that does not exist is REJECTED `ACCOUNT_NOT_ACTIVE` with `to_account_id` NULL, the same answer as a locked account. A `TRANSFER` to the SYSTEM account is refused the same way; one from it fails the source-ownership check (404 plus a `DENIED` audit row), because SYSTEM belongs to no customer (docs/03 §6.1).
- Day limit: DEBIT lines since midnight `Asia/Ho_Chi_Minh`, in SQL, on the partial index; "now" comes from an injectable clock so the midnight test is possible.
- Deposit = same flow, `type = DEPOSIT`, from the SYSTEM `funding` account, operator only.
- Reconciliation runs in the `worker` role; prove it by corrupting a balance on purpose in a test.

## Identity and accounts

Sources: docs/03 §6.2, §7, §12, ADR-06, ADR-12.

- Request checks in order: verify the access token with cached JWKS (`iss`, `client_id`, `token_use = access`, `exp`; access tokens carry no `aud`) → revocation mark → role guard → **ownership check in the service**. A role guard alone lets any customer reach any account.
- Roles come from `cognito:groups`; a token with no group is `customer`. Never read a role from body or headers.
- Another user's resource is **404**, and the denial is audited `DENIED` in its own transaction.
- A token whose `iat` is in the same second as `sessions_revoked_at` is rejected; the next second is accepted.
- Lock = one transaction (status, `sessions_revoked_at`, audit, outbox `AccountStatusChanged`); the Redis mark is written **after** commit. A Redis miss or error reads Postgres; it never means "not revoked".
- Account limit of 3: lock the `customers` row, then count, inside the opening transaction. Onboarding is idempotent.
- Every endpoint's OpenAPI has role, examples and the `ErrorCode`s it can return; money fields are strings.

## Async, events and audit

Sources: docs/03 §10, §11, ADR-03, event-contract, database-design §4.6–4.9.

- Producers call `OutboxWriter.add(manager, event)` in their own transaction. Only the relay (worker) talks to SQS: lock unpublished rows (`SKIP LOCKED`), send to **every** routed queue, then set `published_at`. The relay must not run inside `TransactionService.run`'s deadlock retry: a retried callback would send the messages again; give it its own transaction and timeout.
- One queue and one DLQ per consumer. A consumer inserts `processed_events(consumer, event_id)` in the same transaction as its effect; deletes the message only after commit; sends a malformed message to the DLQ itself at once; acknowledges a known-but-unhandled type; leaves a transient error for redelivery (DLQ after 5 receives).
- Consumers start only when `runsWorkers()` and never rely on arrival order.
- `AuditService.record` runs in the caller's transaction and fails closed; ids and codes only, no PII.
- `correlationId` is server-generated and travels request → outbox → message → consumer → audit through `AsyncLocalStorage`.
- `TransferRejected` is not emitted in v1.

## Foundation (libs, health, harness, data)

Sources: ADR-12, docs/03 §9, §14, `load-tests/README.md`.

- Every Redis call goes through `libs/redis`: timeout, circuit breaker, explicit error so the caller falls back; a metric counts each fallback. Test Redis **slow**, not only off.
- `libs/sqs` is the only way to talk to SQS; the same code runs against ElasticMQ and SQS.
- `/health/ready` reports Redis as degraded, never down, and fails only when PostgreSQL does.
- The Testcontainers harness (to be built by DBS-39 to 41) starts Postgres, Valkey and ElasticMQ, creates the production DB roles, and gives each suite its own database cloned from a migrated template (truncate is blocked by the append-only triggers). Docker missing means the test fails loudly. Until it exists: `testing.md`, "Not built yet".
- `backend/test/support/invariants.sql` is the shared five-invariant check: debit/credit totals, account balances, total balances, non-negative customer balances, and complete/correct transfer pairs. Use checkLedgerInvariants(runner) after money tests or npm run --silent check:invariants from backend after a load run; require exit 0 (1 violations, 2 check error). Funding may be negative. Usage and limits: [backend README](../../../../backend/README.md#9-kiểm-tra-bất-biến-sổ-cái).
- Seed only through the deposit API, never `UPDATE accounts SET balance`.

## Migrations and database

- Check against `database-design.md` §12: `bigint` money with `CHECK (amount > 0)`; `timestamptz`; `text` + `CHECK`, no `ENUM`; foreign keys `RESTRICT`; a one-line reason for each index; append-only tables get the trigger and no UPDATE/DELETE grant; `CREATE INDEX CONCURRENTLY` on populated tables; a `down` that refuses to destroy data; expand → migrate → contract.
- Migrations run as a pipeline step (`migration:run:prod` from `dist/`), never at app start. Name constraints explicitly so tests assert the constraint name.
