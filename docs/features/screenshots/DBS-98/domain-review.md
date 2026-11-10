# Domain Review — DBS-98: Test đồng thời: hạn mức ngày và số dư (AC-5.6, 5.2)

- **Reviewer:** Adversarial Self-Review (Gemini 3.8 Flash)
- **Target:** DBS-98 Concurrency Verification (AC-5.6, AC-5.2)
- **Verdict:** PASS WITH RECOMMENDATIONS

## Findings

1. **[RESOLVED - Medium] Race condition on daily limit counter:**
   - *Concern:* Does the PostgreSQL index on `ledger_entries` handle concurrent DEBIT aggregations without deadlocking?
   - *Resolution:* Verified by `TC-98-01..02`. Both parallel requests lock the account row in consistent ID order before evaluating `SENT_TODAY_SQL`. Exactly one request passes the threshold (180m + 15m = 195m <= 200m), and the second fails with 422 `LIMIT_PER_DAY_EXCEEDED`. Invariant checker confirms 100% PASS across 10 consecutive rounds.

2. **[RESOLVED - Medium] Balance non-negativity under concurrent bursts:**
   - *Concern:* Can multiple parallel transactions drain an account balance below zero?
   - *Resolution:* Verified by `TC-98-03..04`. 20 concurrent requests for 10,000 against a 50,000 balance result in exactly 5 successes (201) and 15 failures (422 `INSUFFICIENT_FUNDS`). Balance remains strictly 0, and total outgoing lines equal 50,000. Verified across 10 consecutive rounds.

3. **[RESOLVED - Low] Flakiness & Test Isolation:**
   - *Concern:* Consecutive runs sharing the same Testcontainers database must not leak state across rounds.
   - *Resolution:* Each round creates fresh sender/recipient target accounts via `seedDepositTarget`. Checker `checkLedgerInvariants` runs after each round with 0 violations.
