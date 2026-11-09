# RSK-02 durable request gate

## Design and test intent (written before implementation)

A PostgreSQL SECURITY DEFINER function serializes acquisitions on one singleton policy row. An operator must provision explicit positive daily-request and concurrent limits; no seed enables AI. Clients present exactly the same limits and policy revision or receive unavailable. UTC day is selected from database clock after locking, not worker time. Daily reservations are never refunded, including uncertain commits, unsent calls, crashes, and provider errors. A request budget is NOT a monetary/billing cap; timed-out or aborted external calls may still be billed.

Distinct UUID permits remain active across midnight and process crashes. No leases expire automatically. A worker releases only after its external operation has actually settled; timeout does not establish provider-side cancellation. Recovery requires disabling egress/stopping all participating workers, establishing no old operation can still execute, then an operator releasing stranded tokens. If that cannot be established, keep capacity unavailable. Never reset the daily count. Policy changes require the same quiescence and must preserve counts. One shared database/policy covers every worker using this external service.

Acquisition/release each use a new pg client with finite connect/query/server lock/statement timeouts. On ambiguous acquisition, deny and retain any committed reservation. Cleanup is best effort and bounded; failure intentionally strands capacity. Release is idempotent at the database and caller. No sensitive feature data enters SQL or logs. Runtime receives only EXECUTE on the two functions, no table rights; migration owner must not be the runtime role, and PUBLIC schema CREATE must be revoked by deployment. No runtime DDL.

Tests use isolated real PostgreSQL: simultaneous distinct clients, request/concurrency boundaries, duplicate release, UTC rollover with retained permits, abandoned client/restart, outage, row-lock deadline, absent/malformed/mismatched policy and narrow permissions. Standalone smoke driver exercises the gate without a provider or cloud request. Tests and smoke are not executed by this worker per assignment.

## Planned files and handoff

New migration 1795000001000; `backend/src/modules/risk/ai/ai-gate.ts`; `backend/test/db/ai-gate.db-spec.ts`; `backend/test/manual/ai-gate-smoke.ts`. Runtime wiring and explicit worker grants are integrated separately. Rollback requires quiescence and a transaction and refuses once any reservation history exists; it never resets an active daily budget.

## Runnable contract

`new AiGate({ connectionString, policy: { revision, dailyRequestLimit, concurrentLimit }, deadlineMs })`. All limits/deadline must be explicit positive signed-32-bit integers; revision is 1–128 characters. An omitted option, invalid value, mismatched/missing database policy, missing permission, timeout or database fault returns `{ kind: 'unavailable' }`. The database request cap returns `{ kind: 'budget_exhausted' }`. Success returns `{ kind: 'granted', release: () => void }`. Integrate as `tryAcquire: () => gate.tryAcquire()` (do not pass an unbound method). `tryAcquire` is asynchronous, compatible with the shared `PermitResult | Promise<PermitResult>` interface.

`release()` returns immediately and initiates one bounded best-effort database update. Repeated local calls are no-ops; repeated SQL calls do not change the original release timestamp. It does not return unused request reservations. Do not use it to declare a still-running client operation complete. PostgreSQL startup lock/statement timeouts and client deadline bound queries; abandoned/uncertain requests can conservatively consume a reservation even when admission returned unavailable. No exactly-once paid-call guarantee exists.

## Exact schema and permissions

Migration class `CreateAiGate1795000001000` creates:

- `public.ai_gate_policy(singleton boolean PRIMARY KEY CHECK(singleton), revision text NOT NULL CHECK(length BETWEEN 1 AND 128), daily_limit integer NOT NULL CHECK(>0), concurrent_limit integer NOT NULL CHECK(>0))`.
- `public.ai_gate_days(day date PRIMARY KEY, requests bigint NOT NULL CHECK(>=0))`: UTC calendar date from PostgreSQL `clock_timestamp()` after acquiring the policy row lock.
- `public.ai_gate_permits(token uuid PRIMARY KEY, reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(), released_at timestamptz NULL)`, plus a partial active-token index.
- `public.ai_gate_acquire(uuid,text,integer,integer) RETURNS text` and `public.ai_gate_release(uuid) RETURNS void`, SECURITY DEFINER, fixed `pg_catalog, public` search path. Acquisition is a single autocommit statement; all budget/count/token changes are one atomic transaction. A UUID is generated afresh for each admission attempt; collisions deny, never grant twice.

Migration owner is trusted and separate from runtime. It must be able to create the objects, own the functions/tables, and must not be an untrusted runtime role. Runtime must not inherit owner/superuser/table-write or policy-write roles. Deployment must ensure no untrusted role has CREATE on `public` or can replace these functions. PostgreSQL must be durable (normal synchronous commit, no lost acknowledged writes), use a reliable UTC clock, and all relevant workers must share this same database and singleton. A database restore to an earlier state cannot preserve the cap: keep AI disabled through restoration and reconcile reservations/budget before reopening. No Redis dependency or Redis-loss reset exists.

PUBLIC receives no table or function privileges. No named runtime role is assumed/created by the migration. A trusted deployer grants only schema USAGE and function EXECUTE to its existing dedicated worker role:

```sql
GRANT USAGE ON SCHEMA public TO approved_ai_gate_worker;
GRANT EXECUTE ON FUNCTION public.ai_gate_acquire(uuid,text,integer,integer) TO approved_ai_gate_worker;
GRANT EXECUTE ON FUNCTION public.ai_gate_release(uuid) TO approved_ai_gate_worker;
```

The role name above is an operator substitution, not a new production role. Supply an explicitly approved revision and limits by parameterized operator INSERT into `ai_gate_policy`; there are deliberately no example production amounts/defaults and no enabling seed. Gate permission is not permission for external network egress: provider credentials, approved model/rubric configuration and egress authorization remain separate prerequisites. Any authorized runtime may consume capacity and may release a token it knows; tokens must remain private to the owning operation, not exposed via logs. This is a trusted-worker coordination boundary, not an adversarial tenant entitlement system.

## Conservative recovery and retention

1. Disable provider egress/admission and stop every worker sharing the policy, including retries and old deployments.
2. Establish that no abandoned client operation can later issue/continue an external request. Provider execution/billing may outlive abort; if relevant provider completion cannot be established, retain the permit.
3. As the trusted operator, inspect active tokens and mark only proven-finished abandoned tokens released using `ai_gate_release(token)`. Record the action in the deployment's operator audit process; this component does not invent an audit sink.
4. Preserve every current-day count. Never delete/reseed today's row, truncate tables, restore stale gate state, or lower the recorded requests. Restart/Redis flush do not change these records.
5. Reopen only the approved policy and egress. Policy revision/limit changes require the same quiescence; retain all daily counts and active tokens. Lower limits conservatively deny until usage falls below the new cap or a new UTC day starts.

Active permits do not expire at midnight. Old-day counts do not carry into a new UTC day; outstanding permits still count globally. No automatic cleanup task exists. Operator retention may delete released tokens only after the owning processes can no longer act on them; never delete active permits or today's request counter. Lost release capacity is intentional fail-closed behavior, not an availability bug to bypass.

## Verification

From `backend/`, parent can run:

```sh
npm run typecheck
npm run test:db -- --runInBand ai-gate.db-spec.ts
AI_GATE_SMOKE_ALLOW_DDL=isolated-only AI_GATE_SMOKE_DATABASE_URL=\"$ISOLATED_EMPTY_PG_URL\" node -r ts-node/register test/manual/ai-gate-smoke.ts
```

The smoke requires an isolated **empty and disposable** PostgreSQL database, checks for existing public tables before DDL, and applies only the gate migration. Because rollback refuses populated budget history, the caller must drop this isolated database after the run. Never target a deployed application database. The db-spec uses the temporary-database helper; process tests require Node and installed ts-node. Day-boundary coverage seeds persisted prior-day state; it does not exercise a live midnight crossing.

On 2026-11-09, targeted lint/typecheck and 11 real PostgreSQL gate tests passed, including rollback refusal after a reservation; the isolated manual smoke passed without provider requests. Integrated runtime wiring requires separate verification.
