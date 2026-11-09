<!-- Reviewer: same subagent (Opus, effort medium), 2026-11-10, round 2 on the revised §2–§5. Raw reply below, unedited. -->

Round 2: all 10 findings from round 1 are resolved. The changes introduce one new minor finding.

| # | Severity | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| N1 | minor | §2 H1 row 1, §4 TC-159-01 | TC-159-01 compares Bình's 404 with "the 404 of a random `fromAccountId`". That comparison request is also sent by Bình, and it writes its own DENIED `ledger.transfer` row with `actor_user_id` = Bình. So "một dòng `DENIED` `ledger.transfer` của Bình" will count 2 rows if the reference request is sent before the assertion or counted with it. | `backend/src/modules/accounts/accounts.service.ts` `getOwnedAccount` (a missing account calls `recordDenied` with the same actor and action); `transfer.service.ts` `transfer()` | Look up the DENIED row by `correlation_id` from the response, or say that there is exactly one row per request (two in total once the reference request is sent). |

How each round-1 finding was resolved:

1. **T was readable by Bình.** T is now A1 → A2, between An's own accounts, so Bình is neither sender nor recipient. 404 with DENIED `transfer.read` matches `transfer-query.service.ts`. A transfer to the same owner is allowed: `TransferDto` and `SyncGuardService` have no same-owner rule. SAVINGS is in `accounts_type_check` and in `open-account.dto.ts`.
2. **Column names.** `initiated_by`, `actor_user_id` and `actor_role` match the migrations.
3. **No audit row on 403.** The doc now asserts that a 403 adds no `audit_log` row, and BL-132 is handed off. This matches `roles.guard.ts`.
4. **An needed two accounts.** M-159-01 now creates A1 and A2. The lock body's `reason` is a free string, checked by `parseStatusReason`, so `CONFIRMED_FRAUD` is accepted.
5. **Manual setup.** Variables already in the environment win over the env file, which `load-env.ts` documents. The role migration uses `IF NOT EXISTS`, so migrating a second database works. Each actor now gets its own `--sub`.
6. **Redis cache path.** The doc now says the suite runs only the SQL path. `session-revocation-cache.db-spec.ts` exists for the cache path.
7. **400 with an error code.** The opening sentence of §2 is now correct.
8. **Missing attack cases.** HS256 is rejected because the verifier allows only `algorithms: ['RS256']`. An ID token is rejected by the `token_use` check. The JWT guard runs before the role guard, so 401 comes before 403. There is no role hierarchy. The audit endpoint's 403 cases are covered in `audit-search.http.db-spec.ts` (customer, operator and admin). `AuditController` lives only in `AuditHttpModule`, which the test harness does not load, so leaving it out here is justified.
9. **"Không ghi DB" too broad.** The tables are now listed, `users` is excluded, and the 404 is compared without `correlationId`. `recordDenied` does not write to `outbox_events`.
10. **Payload-edit recipe and second operator.** The recipe is given and M-159-04 now uses the second operator.

Verdict: APPROVE
