# Automated tests and the security checklist

Used in Phase 2 (writing §4 test cases) and Phase 4 (writing and running the tests). The manual test is separate: `manual-testing.md`.

## Layers

| Layer | Runs on | For | Command (from `backend/`) |
|---|---|---|---|
| Unit | memory, fakes allowed | pure logic: rules, parsing, guard arithmetic | `npm test` |
| Integration / e2e | real PostgreSQL (Testcontainers once the harness exists, otherwise the docker compose database); Valkey and ElasticMQ when involved | money, concurrency, constraints, triggers, DB roles, HTTP contract | `npm run test:e2e` (and `npm run test:db` where a task defines it) |
| Load | k6 against a deployed environment | NFR numbers | #6 writes the scripts, #5 runs them |

A test that mocks the database cannot prove a lock, `ON CONFLICT` or a trigger. Docker down means the money tests are **not run**, reported as such, never skipped into a green result.

## Not built yet: what to do until it lands

Several things this file mentions do not exist at the time of writing. Check with `ls` or `fetch-task.mjs` before relying on one; until it exists, say so in the feature doc instead of assuming it.

| Thing | Built by | Until then |
|---|---|---|
| Testcontainers harness (Postgres, Valkey, ElasticMQ, DB roles, template database per suite) | DBS-39, 40, 41 | Use the docker compose database through `DATABASE_URL`; create and drop your own temporary database; fail loudly when it is unreachable |
| `backend/test/support/invariants.sql` | DBS-69 | Run the four checks as hand-written SQL in the manual test; say so |
| CI workflows (`.github/workflows/` holds only `.gitkeep`) | DBS-35 | "CI green" cannot be met: paste the local command results and mark the DoD bullet as not yet verifiable |
| Dev token helper (`npm run auth:dev-token`) | DBS-53 | `task-kinds.md`, last section |
| `npm run test:db` | defined by the first task that needs it | Use `test:e2e` against the docker compose database |

## Case rules

- Each case traces to a DoD bullet or an AC; assert the `errorCode` (or the SQLSTATE and constraint name for database tests), never message text.
- A case that names a real step (10 parallel requests, a kill, a burst) is not satisfied by a single request.
- Mandatory where they apply: AC-5.1…5.10 for transfers and deposits; one test per DB constraint (insert the bad row, expect refusal, one violation per row); append-only tables refuse UPDATE/DELETE/TRUNCATE as `dbs_api` and the migrator; another user's resource → 404 plus a `DENIED` audit row; an amount above 2^53 survives API → DB → response as a string.

## Deterministic techniques (no sleeps)

- **Parallel burst:** `Promise.all` released together; `DATABASE_POOL_MAX` above N in tests; assert exact counts. A sometimes-red test is a race, never re-run until green.
- **Catch a request mid-transaction:** the test connection holds `SELECT … FOR UPDATE` on an account; start the request; poll `pg_stat_activity` until it waits on `Lock`; then terminate it or start the duplicate.
- **Forced deadlock:** in the test connection `SET deadlock_timeout = '10s'`, lock the higher id, let the transfer take the lower, then request the lower; expect one retry and one COMPLETED.
- **Midnight boundary:** inject the clock; never edit row timestamps or the machine timezone.
- **A TTL** (a 60 s cache, a 15 min token): make the TTL injectable and assert the value Redis reports (`TTL`) or the clock-based expiry, instead of waiting.
- **Data:** seed only through the deposit API, never `UPDATE accounts SET balance`. Each suite gets its own database cloned from a migrated template.
- End every money test with `backend/test/support/invariants.sql`.

## Security checklist for §2 and §4

Add a row per applicable item with the `TC` that proves it; a row without a test is a gap. Say "not applicable + reason" instead of omitting a row.

| Requirement | Enforcement point |
|---|---|
| Right role guard on the endpoint | controller |
| Ownership check on every account-scoped query; 404 for another user's resource | service |
| Idempotency key scoped by user | `PRIMARY KEY (user_id, idem_key)` |
| Business rejection audited `REJECTED` in the same transaction; denial audited `DENIED` in its own | service |
| No fraud-flag field in any customer response (BR-13) | DTO |
| Errors expose no internals, SQL or PII; `correlationId` present | `ProblemDetailsFilter` |
| All SQL parameterized | code + a hostile-input test |
| TLS to Postgres and Redis; no secret in repo, image or log | config, CI scan |

Threat model: `docs/security/threat-model.md`; when a task delivers the evidence for a row, set that row to *Đã kiểm* with the link.
