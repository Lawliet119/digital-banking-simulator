# Testing money paths and the security checklist

Use in Phase 3 (writing §4 test cases) and Phase 4 (writing the tests).

## Layers

| Layer | Runs on | For | Command (from `backend/`) |
|---|---|---|---|
| Unit | memory, fakes allowed | pure logic: rules, parsing, guard arithmetic | `npm test` |
| Integration / e2e | real PostgreSQL via Testcontainers; Valkey and ElasticMQ when involved | money, concurrency, constraints, triggers, DB roles, HTTP contract | `npm run test:e2e` |
| Load | k6 against a deployed environment | NFR numbers | role #6 |

A test that mocks the database cannot prove a lock, `ON CONFLICT` or a trigger. Docker down means the money tests are **not run**, reported as such.

## Case rules

- Each case traces to a DoD bullet or an AC; assert the `errorCode`, never message text.
- A case that names a real step (10 parallel requests, a kill, a burst) is not satisfied by a single request.
- Mandatory where they apply: AC-5.1…5.10 for transfers and deposits; one test per DB constraint (insert the bad row, expect refusal); append-only tables refuse UPDATE/DELETE/TRUNCATE as `dbs_api` and the migrator; another user's resource → 404 + `DENIED` audit; an amount above 2^53 survives API → DB → response as a string.

## Deterministic techniques (no sleeps)

- **Parallel burst:** `Promise.all` released together; `DATABASE_POOL_MAX` above N in tests; assert exact counts. A sometimes-red test is a race, never re-run until green.
- **Catch a request mid-transaction:** the test connection holds `SELECT … FOR UPDATE` on an account; start the request; poll `pg_stat_activity` until it waits on `Lock`; then terminate it or start the duplicate.
- **Forced deadlock:** in the test connection `SET deadlock_timeout = '10s'`, lock the higher id, let the transfer take the lower, then request the lower; expect one retry and one COMPLETED.
- **Midnight boundary:** inject the clock; never edit row timestamps or the machine timezone.
- **Data:** seed only through the deposit API, never `UPDATE accounts SET balance`. Each suite gets its own database cloned from a migrated template (truncate is blocked by the append-only triggers).
- End every money test with `backend/test/support/invariants.sql`.

## Security checklist for §3 and §4

Add a row per applicable item, each with the `TC` that proves it; a row without a test is a gap.

| Requirement | Enforcement point |
|---|---|
| Right role guard on the endpoint | controller |
| Ownership check on every account-scoped query; 404 for another user's resource | service |
| Idempotency key scoped by user | `PRIMARY KEY (user_id, idem_key)` |
| Business rejection audited `REJECTED` in the same transaction; denial audited `DENIED` in its own | service |
| No fraud-flag field in any customer response (BR-13) | DTO |
| Errors expose no internals, SQL or PII; `correlationId` present | `ProblemDetailsFilter` |
| All SQL parameterized | code + a hostile-input test |
| TLS to Postgres and Redis, no secret in repo, image or log | config, CI scan |

State "not applicable + reason" for OWASP categories that do not apply rather than omitting them. Threat model: `docs/security/threat-model.md`; when a task delivers the evidence for a row, set that row to *Đã kiểm* with the link.
