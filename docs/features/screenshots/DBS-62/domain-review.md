| # | Severity | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §4 TC-62-04/07; §5 M-62-02/05 | GET success has no explicit assertion that exactly one `customer.read` audit is persisted. Audit-failure coverage exercises creation only, leaving GET/replay fail-closed behavior without explicit evidence. | `docs/02_REQUIREMENTS_AND_DOMAIN_MODEL.md` FR-AUD-02; `backend/src/modules/audit/README.md` “Phải giữ”; design §2 requires read audit in the transaction. | Extend cases to assert GET/replay audit actor, target and correlation ID. Reject audit INSERT during GET/replay and assert sanitized failure, with no profile disclosed and stored profile unchanged. |
| 2 | minor | §2 | “users.id UNIQUE in customers” names the wrong column. The intended concurrency invariant is correct in §3. | `backend/src/database/migrations/1791763200000-CreateUsersCustomersAccounts.ts`: `customers_user_id_key UNIQUE (user_id)`; database-design §4.1. | Replace with “`customers.user_id UNIQUE` guarantees one profile per user.” |

Verdict: APPROVE
