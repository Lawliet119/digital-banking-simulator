<!-- Reviewer: same subagent (Opus, effort medium), 2026-11-10, round 3 on the round-2 fixes. Raw reply below, unedited. -->

Round 3: all four round-2 findings are resolved, and the changes added only one minor finding. I'm approving.

- **v2-1 (mode passed to `score()`):** resolved. A broken `ai` block flows through `parseRuleSet` and `ScoringService` to `CONFIG_INVALID`, which passes the third branch of the RSK-01 `mode_metadata` CHECK. A valid `ai` block now gets `{...ruleSet, mode:'rule_only'}`, which gives `rule_only` / `DISABLED` and passes the first branch. The `mode` and `ai_status` columns are now taken from the scoring result.
- **v2-2 (rule-set versions leaking between tests):** resolved. TC-111-11a/b now live in their own db-spec file, and `test/jest-db.js` gives each file its own database. The 11b version is inserted after 11a's, so `ORDER BY version DESC LIMIT 1` picks the version each case means.
- **v2-3 (TC-111-13 harness):** resolved. `APP_ROLE=both` is a valid role in `app-role.ts` and runs HTTP and the worker loops in one app. A second call to `PollingLoop.start()` does nothing, and the relay polls every 500 ms when idle. It now has its own step in the CI `e2e` job.
- **v2-4 (M-111-03 and setup):** resolved. The reverse query in `transfer-facts.ts` finds An's 20M transfer to Bình within the hour, so R4 fires (20) and the result is LOW with `rule_score` 20. R5 (1 new recipient), R6 (5%), R3 (1M) and R1 (1 transfer) don't fire. The `POST /v1/customers/me` onboarding step is now in setup.

| # | Severity | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | minor (new) | §4 TC-111-13; §3 Interface | The test needs a 1-second long poll, but the doc doesn't say how to get one. The polling loop calls `this.consumeOnce()` with no arguments, so it always uses the hard-coded `LONG_POLL_SECONDS = 20`. Nothing lets a test lower it. The §3 list of `ConsumerBase` changes doesn't include such a hook either. | `backend/src/common/messaging/consumer-base.ts` (constructor loop calls `this.consumeOnce()`; `const LONG_POLL_SECONDS = 20`) | Either add a `protected get longPollSeconds()` (default 20, next to `retryBackoffSeconds`) and list it in §3 and TC-111-14, or say the test uses a subclass that overrides `consumeOnce(waitTimeSeconds = 1)`. |

Verdict: APPROVE
