# DBS-78 · Redis degraded in readiness

## 1. Scope and dependency

Board Dev, Medium, In Progress. DBS-76 is still In Progress; [Draft PR #52](https://github.com/Lawliet119/digital-banking-simulator/pull/52) is open/unmerged. Fetched origin/main lacks backend/src/libs/redis. User explicitly selected temporary use of DBS-76 on the branch-strategy question. Rebased local feat/DBS-78-health-redis-degraded onto dependency head eb4ec89, with separate DBS-78 commits. No duplicate/stub adapter. After #52 merges, rebase only DBS-78 changes onto main and open a main-based PR; do not open a stacked PR now. Prior user workflow authorizes implementation/tests/manual/commit/push/Draft PR without human gate pauses; no sheet edits or merge.

Existing readiness checks PostgreSQL only via Terminus, timeout1500ms; existing comment promising Redis on a separate endpoint conflicts with the board/docs03 and will be corrected. Existing liveness is public, version-neutral and returns status ok.

## 2. Behaviour

GET /health/ready preserves existing Terminus body and status rules for PostgreSQL, and adds a root redis field on the successful readiness response: up if RedisClient.ping returns PONG, degraded for RedisUnavailableError or a non-PONG reply. Overall status remains ok and HTTP200 when PostgreSQL is healthy, even if Redis is unavailable, timed out or breaker-open. Redis probe uses DBS-76's existing ≤50ms timer; no second raw Redis client or extra retries. A cache outage is informational and must not drain the ALB target.

PostgreSQL failure remains existing non-200/503 Terminus result, database down; skip Redis probe when database readiness already fails. Unexpected programming exceptions are not silently converted to Redis degraded. No URLs, credential, keys, Redis error cause or stack in health responses. GET /health/live remains independent of database/Redis and returns200 status ok. Endpoints stay @Public and version-neutral. No new env/dependency/ADR/ErrorCode.

Example healthy Postgres/failed Redis: {"status":"ok","info":{"database":{"status":"up"}},"error":{},"details":{"database":{"status":"up"}},"redis":"degraded"}. Healthy Redis uses redis=up. Existing database keys are preserved for current callers. Do not place degraded in Terminus's up/down-only indicator type or return a fake database success.

## 3. Architecture

HealthModule imports RedisModule from @libs/redis. HealthController injects RedisClient, awaits existing health.check first, then bounded ping, catches RedisUnavailableError only and returns HealthCheckResult & {redis:'up'|'degraded'}. No application-level fallback logic or change to liveness/worker HTTP policy. Nest owns RedisModule shutdown.

Integration regression found by existing auth bootstrap subprocess tests: eager Redis construction during NestFactory.create left reconnect sockets alive if another provider failed before main received a context. RedisModule now creates the client with lazyConnect=true and starts background connect in onModuleInit (after the context exists). Direct constructor diagnostic callers retain eager default for compatibility. A module that never reaches init opens no Redis socket; opossum timers are already unref'ed. No forced process.exit or longer bootstrap test timeout. Unit and real subprocess regression tests cover this lifecycle change in dependency files redis.client/module/spec.

Existing isolated health tests override RedisClient and typed redisConfig provider (avoid making unrelated unit tests connect real Redis or validating unspecified environment). AppModule e2e tests already provide existing Redis env config; unavailable Redis must not prevent app init or public liveness. Production never imports ioredis outside adapter.

## 4. Planned cases

| ID | Layer and expected evidence |
|---|---|
| TC-78-01 | HTTP e2e, mocked dependencies: Postgres up/PONG ->200 redis up, original database fields retained |
| TC-78-02 | HTTP e2e: Postgres up with Redis TIMEOUT/UNAVAILABLE/CIRCUIT_OPEN ->200 redis degraded; no raw exception data |
| TC-78-02b | HTTP e2e: non-PONG ->200 redis degraded; unexpected Error -> sanitized500 (no stack/cause/secret) using normal application exception handling, not a false200 |
| TC-78-03 | HTTP e2e: Postgres down ->503 database down; Redis not called |
| TC-78-04 | Public/version-neutral /health/live independent of both dependencies, /v1/health/live remains404; no Redis probe |
| TC-78-05 | Real HTTP app + disposable PostgreSQL17 + Valkey Testcontainers via latency proxy: ready200/up, Redis slow250ms ready200/degraded, remove delay ready200/up, Redis stopped ready200/degraded, PostgreSQL stopped ready503; shutdown cleans resources |
| Process | CI green, Dev review, merge, filled PR table |

Real suite belongs test/services/health-readiness.services-spec.ts. Add an explicit workflow step in existing e2e job: `npm run test:services -- --runInBand --runTestsByPath test/services/health-readiness.services-spec.ts` (current workflow does not discover services tests). PostgreSQL and Valkey helper/proxy from dependencies must be present before implementation. Do not claim mocked DB proves a real outage.

## 5. Planned manual script

Implement backend/scripts/manual-dbs78.cjs only after DBS-76 is available. Commands from backend: npm run build; node scripts/manual-dbs78.cjs. Uses real HTTP Nest app with actual HealthModule and TypeORM, disposable local PostgreSQL/Valkey containers and test latency proxy, public dynamic localhost port. Override typed config with actual generated container URLs, no fake DB indicator or Redis service. No AWS resources, no shared Compose PostgreSQL stopped.

| Step | Action | Expected |
|---|---|---|
| M-78-01 | Start app and wait Redis readiness; GET /health/live and /health/ready | Both200; readiness original database up + redis up |
| M-78-02 | Add250ms Redis response delay, GET /health/ready | 200, status ok, redis degraded; DB still up; no secret/cause |
| M-78-03 | Remove delay and GET /health/ready | 200 redis up; wait for half-open if breaker was opened |
| M-78-04 | Stop owned Valkey container, GET /health/ready | 200 redis degraded; liveness200 |
| M-78-05 | Stop owned PostgreSQL container, GET /health/ready | 503 database down; liveness200 |
| M-78-06 | finally close app/proxy and stop owned containers | No leaked handles or shared service stop; transcript first line final code SHA, all assertions print PASS and exit0 |

## 6. Review

Independent design review identified two should-fix gaps: explicitly wire services suite into CI and test non-PONG/unexpected-error response rules. Both added to §4/§7. [Final review APPROVE](screenshots/DBS-78/domain-review.md). User approved the temporary dependency branch strategy before implementation.

## 7. Plan

1. Use DBS-76 head eb4ec89 temporarily as explicitly authorized. After it merges, fetch main and rebase only DBS-78 commits onto main. Open PR after dependency merge; no stacked PR during preparation.
2. Add HTTP failure cases first, run red because redis status absent. Add real service suite to prove slow/down/no false ALB failure.
3. Import RedisModule and update controller response/type/comment with minimal change. Update existing isolated tests and config overrides, inspect callers of HealthController/HealthModule.
4. Add explicit targeted test:services command to existing e2e workflow job; keep required check names unchanged. Run lint/typecheck/build/unit/e2e/services; manual on final code commit; docs/README/index/backlog and link check; commit/push/Draft PR and CI.

## 8. Current evidence

Implemented on temporary dependency base eb4ec89 as explicitly authorized; separate code commit f056393. Red-first HTTP suite: six failures because Redis field/probe absent and unexpected exception not observed. Initial targeted HTTP baseline4/4 passed. New health HTTP10 cases include Swagger schema. Integration exposed startup reconnect leak; RedisModule lifecycle fix passed new Redis unit7/7 and existing auth real-process4/4 without changing timeouts. Independent follow-up review approved.

Real services readiness4/4 plus Redis regression3/3 passed with --detectOpenHandles, no handle warnings. Final lint/typecheck/build passed. Full unit777/777 and E2E141/141 passed after lifecycle fix, zero skipped. Initial full E2E was139/141 because two real-process startup tests timed out with eager Redis sockets; corrected lifecycle and reran complete suites, without weakening timeouts/assertions. Docker was initially stopped, so the first real-services attempt failed at runtime discovery (not skipped); started installed Docker Desktop and reran against actual containers.

Manual M-78-01..06 passed on codeSHA f056393: healthy200/up, proxy delay250ms200/degraded, recovery200/up, stopped Valkey200/degraded with live200, stopped PostgreSQL503/down with live200, complete app/proxy/container cleanup. No shared Compose service was stopped. [Transcript](screenshots/DBS-78/manual-test.txt), [actual-output image](screenshots/DBS-78/01-manual-output.png).

| DoD | Evidence | Result |
|---|---|---|
| PG healthy/Redis slow or down ->200/degraded | TC-78-02/05 and M-78-02/04 | Passed on actual HTTP/PostgreSQL17/Valkey and TCP proxy |
| PG down ->non200 | TC-78-03/05 and M-78-05 | Actual stopped PostgreSQL ->503/down; Redis probe skipped; live200 |
| E2e both cases | health.e2e-spec.ts + health-readiness.services-spec.ts | Mocked contract cases plus real outage tests, no skip |
| Public/version-neutral/no secret | TC-78-02b/04 and existing app guard suites | Response sanitization, unchanged paths/liveness and OpenAPI up/degraded |
| PR/main/CI/Dev review | BL-142 | Pending dependency PR52 merge; main-based PR not opened under agreed strategy |

BL-142 tracks dependency merge, rebase of only DBS-78 commits onto main, Draft PR/CI and Dev review/merge. [Remote branch](https://github.com/Lawliet119/digital-banking-simulator/tree/feat/DBS-78-health-redis-degraded) contains separate DBS-78 commits above temporary dependency base eb4ec89. PR52 was still open/Draft/unmerged at handoff. Per explicit user strategy, no DBS-78 PR opened yet, so no DBS-78 CI run is claimed. Keep board In Progress until a PR is opened. No live cloud/ALB outage performed or claimed. No new package/env/auth/money/schema rule.

## 9. Sources

[Architecture](../03_HIGH_LEVEL_ARCHITECTURE.md) §9.3/§13/§14, ADR-12, board DBS-78, health controller/module/test, Redis public contract from PR52. [Delivery skill](../../.claude/skills/dbs-delivering-task/SKILL.md) requires unfinished dependencies to be reported and forbids stubbing the missing service.

Updated backend README, health README/OpenAPI, Redis README lifecycle note, docs/03 implementation contract, feature index/backlog. Relevant dependency delta is limited to lazy module initialization and its regression test; direct Redis diagnostic constructor default remains compatible. Documentation link check passed190 files/0 broken links.
