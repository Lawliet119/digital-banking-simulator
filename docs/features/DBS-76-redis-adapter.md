# DBS-76 · Redis timeout and circuit breaker

## 1. Scope

Board Dev, High, In Progress, DBS-40 Done. Main has Valkey Testcontainers but no ioredis/opossum runtime adapter or metrics infrastructure. User requests same workflow as DBS-96/77: implement, independent design review, tests/manual, commit/push/Draft PR without gate pauses. No board editing or merge.

## 2. Behaviour

RedisClient exposes get, set(key,value,ttlSeconds), incr(key,ttlSeconds), zadd(key,score,member,ttlSeconds), zrangebyscore, del, ping. TTL must be a safe integer 1..604800 seconds (max7days per ADR-12), validated before invoking Redis for set/incr/zadd; oversized/unsafe/zero TTL throws TypeError, leaves key unchanged and does not increment fallback metric. incr/zadd use one Lua script to mutate and EXPIRE without interleaving. Lua does not roll back writes before a runtime/ACL error; write errors remain indeterminate. No money/business data, auth changes or balance cache. Values/counter results are strings (INCR then GET in Lua preserves int64 exactly), scores/range bounds are finite safe integers. Every command passes the same opossum breaker; no generic raw ioredis escape hatch.

Timeout is min(REDIS_COMMAND_TIMEOUT_MS,50) using existing config (10..1000); larger config still capped 50 per ADR-12. Command deadline rejects explicitly, not a hard real-time scheduler guarantee. Offline queue disabled, maxRetriesPerRequest 0, unfulfilled commands never resent. Background reconnect allowed without buffering operations. Connect/readiness errors don't leak URL, password, key/value or cause messages. Return RedisUnavailableError with bounded reason TIMEOUT/CIRCUIT_OPEN/UNAVAILABLE/COMMAND_FAILED/SHUTDOWN. Errors tell caller to fail-open for rate limit or query Postgres for revocation/features/config. A timeout on a write is indeterminate; never retry a non-idempotent increment as if it had rolled back.

Breaker config ADR-12: errorThresholdPercentage 50, volumeThreshold 10, rolling window 10000ms, reset 5000ms. Tests verify all-failure opening at 10 requests and 50% boundary, half-open success recovery. Inspect opossum implementation for exact threshold semantics; close any >= versus > discrepancy without changing accepted constants. Expose read-only state (closed/open/half-open) for tests/health integration, no polling loop.

RedisMetrics injectable owns dedicated prom-client Registry + Counter redis_fallback_total, incremented once per operational command rejection at adapter fallback boundary (including circuit open/not ready), not per reconnect event or caller validation error. Expose metrics() and count() for future metrics endpoint. No high-cardinality/key labels or secret logs. No HTTP metrics endpoint in this task; dashboard wiring is handoff. Module exports RedisClient/RedisMetrics; no AppModule integration until caller task. Lifecycle destroy shuts breaker timers and disconnects ioredis sockets/reconnect timers.

## 3. Architecture

@libs/redis exports RedisModule, RedisClient, RedisMetrics, RedisUnavailableError. Module uses existing redisConfig, normal ioredis node client for redis:// local and rediss:// cloud with standard TLS verification. Add ioredis, opossum and prom-client runtime dependencies plus @types/opossum dev; no new env or ADR. Lua scripts parameterize keys/values and only implement cache/counter mutations. No dependencies from libs to business modules. Existing node-redis in test harness remains admin/test-only; no production direct ioredis outside adapter, enforced by ESLint.

Test-only TCP latency proxy connects host mapped Valkey port. Proxy delays server responses 250ms (above 50ms); owns sockets/timers, preserves byte order and flushes in order when latency removed; closes everything in finally. Helpers do not change cloud networking. CI adds targeted Redis services suite to existing e2e job, keeping required names.

## 4. Cases

| Case | Evidence |
|---|---|
| TC-76-01 | Unit config cap/defaults/no offline replay, typed redacted errors, metric increments once, validation no metric, Nest DI/shutdown |
| TC-76-02 | Real Valkey get/set/incr/zadd/range/del/ping, TTLs positive and atomic script behavior, absent key null; oversized TTL set/incr/zadd reject with unchanged/absent keys and unchanged metric |
| TC-76-03 | Real proxy slow 250ms: 10 failures open breaker, next call short-circuits and metric increments; restore proxy then real half-open recovery after 5s |
| TC-76-04 | Valkey stopped: explicit error and counter increase; no hang; lifecycle stops sockets/timers |
| TC-76-05 | Unit fake clock: exact 5 failures/10 calls opens, 4/10 stays closed, 10s rolling window/reset5s and half-open recovery; no command replay |
| Process | Full CI checks, other Dev review/merge, PR DoD table |

## 5. Manual

From repo `docker compose up -d valkey`; from backend `npm run build`; `node scripts/manual-dbs76.cjs`. Keep driver in PR. Creates unique cache key prefix, uses local Compose via test TCP proxy, never AWS.

| Step | Action | Expected |
|---|---|---|
| M-76-01 | Ready/connect, get/set/incr/zadd/range with TTL | Values correct; counter string preserved, TTL positive; print operations PASS |
| M-76-02 | Reject zero TTL | TypeError before Redis, fallback count unchanged; print validation PASS |
| M-76-03 | Set proxy latency250, perform 10 reads with50ms deadline | Typed TIMEOUT errors, breaker open, count10; next call CIRCUIT_OPEN count11; print slow PASS |
| M-76-04 | Remove latency, wait bounded real reset5s, issue probe | Successful read and breaker closed; print recovery PASS |
| M-76-05 | Close proxy to simulate unavailable network | Typed rejection, count grows; print down PASS |
| M-76-06 | Finally cleanup owned key prefix if reachable, stop proxy and client | TTL prevents leftovers; sockets/timers stopped, print cleanup PASS, exit0 only if assertions passed |

## 6. Review

Independent subagent review found one blocking TTL bound gap; fixed §2/TC-76-02 with safe integer1..604800 validation before mutation, and clarified Lua cannot rollback runtime errors. Final [raw verdict APPROVE](screenshots/DBS-76/domain-review.md).

## 7. Plan

Baseline lint/typecheck/unit/e2e; tests red for missing adapter. Install locked dependencies after baseline (no concurrent install/tests). Implement adapter/module/metrics and proxy helper; unit/fake-clock and real services tests; lint/typecheck/build/unit/e2e/services and CI step. Commit code, run manual on SHA, capture output/actual-output image, docs/backlog/index, push Draft PR. No new health API (DBS-78), rate limiting (DBS-89), business resilience (DBS-100) or live AWS session (BL-116 stays open). Rollback unconsumed libs and dependency additions; no data/schema migration.

## 8. Results

Code `6fd02bc`. Red first: missing adapter module TS2307. Baseline main lint/typecheck passed; unit769/770 (known Identity cooldown BL-112), E2E135/135. Final lint/typecheck/build passed; unit776/776, final E2E135/135. New unit6/6 and Valkey services3/3 passed, no skip. `--detectOpenHandles` completed without handle warnings after removing ioredis's default2second force-close delay at shutdown. Proxy originally coalesced replies too early; corrected each chunk due-time/FIFO ordering, then slow/outage/recovery assertions passed. Dependencies pinned ioredis5.11.1 (6.x conflicts with existing TypeORM optional peer), opossum10.0.0, prom-client15.1.3, @types/opossum8.1.9.

Manual M-76-01..06 passed on codeSHA `6fd02bc`: exact int64 counter and TTL, invalidTTL no mutation/metric, ten timeouts with proxy250ms (observed50–58ms timer scheduling), circuit-open next call skipped wire and counter11, recovery after5s, network-down typed error and counter12, keys/proxy/client cleaned. [Transcript](screenshots/DBS-76/manual-test.txt), [actual-output excerpt](screenshots/DBS-76/01-manual-output.png). Fresh client before fault stage isolates the10-call breaker volume from earlier successful operation checks. No hard real-time wall-clock50ms claim.

| DoD | Evidence | Result |
|---|---|---|
| ioredis timeout≤50, explicit errors, breaker | TC-76-01/03/05 | Config capped50, fake-clock50ms rejection, exact5/10 boundary and4/10 non-open, rolling10s/reset5s, real proxy250ms timeouts/recovery |
| redis_fallback_total | TC-76-01/02/03/04, manual | Prometheus Counter increments once per operational rejection; misses, invalidTTL, reconnect events do not increment |
| Real slow and down | TC-76-03/04 | Actual Valkey container via delay proxy; container stopped; errors do not hang; cleanup checked |
| get/set/incr/zadd etc and no direct imports | TC-76-02 + ESLint policy | TTL60positive, invalidoversizedTTL no writes, exactcounter>2^53; production ioredis use confined to adapter |
| CI/review/merge | Draft PR checks | Review/merge pending BL-140 |

BL-116 cloud app integration not assumed from local tests and remains open. BL-119 worker SG networking belongs Ops. BL-141 tracks metrics HTTP/dashboard integration, not a fake endpoint. Operational failures are adapter fallback signals; it does not execute Postgres fallbacks itself. Health/rate-limit/business resilience remain DBS-78/89/100. User authorized prior workflow without human gate pauses; design review, tests and manual still completed before Draft PR. No schema/auth/env/ADR changes, no cloud session/resources or secret output.

## 9. Sources

ADR-12, docs/03 §9/§14, config/redis.config.ts, database-design, BACKLOG BL-116/119. Changes planned: libs README, adapter README, CI, feature index and backlog.

Updated [adapter README](../../backend/src/libs/redis/README.md), libs README, feature index/backlog, ESLint import enforcement and CI targeted services step. Test proxy is kept for reviewer replay; manual driver uses only local Compose.
