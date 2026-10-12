# Team and ownership

Six people, two kinds of role. **Four software developers** (#1, #2, #3, #6) all do the same job on every task: plan, implement, test, manual test. **#4 Fraud** and **#5 Platform & Ops** own a domain of their own. The numbers #1 to #6 are stable labels used on the board and in PRs.

| # | Role | Primary ownership | Pair (reviews its PRs) |
|---|---|---|---|
| 1 | Dev · Ledger | `modules/ledger`; sync guard (`checkGuards`); DB roles and grants; review of every migration; `database-design.md` | #4 |
| 2 | Dev · Accounts & Identity | `modules/identity`, `modules/accounts`; rate limit; OpenAPI quality of the whole system | #3 |
| 3 | Dev · Async & Audit | `modules/outbox`, `notification`, `audit`; event contract and `common/events`; queue and flag-latency metrics | #2 |
| 4 | Fraud | `modules/risk` (rules, scoring, flag review API, rule-set config); offline evaluation; ADR-08 | #1 |
| 5 | Platform & Ops | `infra/`, deploy pipeline, AWS account and cost; operations: dashboards, alarms, load-test and failure-drill execution on the cloud, rollback | #6 |
| 6 | Dev · Foundation & Data | `libs/redis`, `libs/sqs`, `modules/health`, logger and `correlationId`; Testcontainers harness and CI test jobs; invariant script; seed; fraud dataset generator; k6 scripts; adversarial concurrency and security suites; P4 package | #5 |

## How the roles work together

- **Every developer tests their own work** (unit, integration, manual test) as part of the task. #6's concurrency and security suites are an *additional*, adversarial check by a second person on money and auth paths.
- **A module has one owner.** Another developer who needs a change inside it agrees the interface in an issue, then opens a separate PR that the owner reviews. Roadmap signatures are agreed: code against them; if the owner has not delivered one, ask for a date.
- **The pair reviews the PR** (after the AI domain review at G2 has already shaped the design). Review of Terraform and CI goes to #6, of risk code to #1, of ledger code to #4.
- **The wall:** #6 writes and holds the fraud dataset generator and the holdout labels; #4 and any agent working for #4 never read the generator code (`references/fraud.md`).
- **Defense questions:** #1: 4, 5. #2: 1, 3, 9. #3: 7. #4: 12. #5: 8, 9, 11. #6: 2, 6, 10 (with #5's operations evidence). Each answer needs an evidence link from a feature doc.
