| # | Severity (blocking / should-fix / minor) | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| — | — | §1–5, §7 | Không phát hiện vấn đề đã xác minh cần sửa. Thiết kế phân biệt ACL với trigger, kiểm đầu vào hợp lệ, rollback khi bất ngờ được phép và cô lập thay đổi role/GRANT trong container riêng. | `database-design.md` §8.1–8.3; `infra/scripts/db-roles.sql`; migrations `1793664000000`, `1792713600000`, `1791849600000`; `db-roles.db-spec.ts`; `.github/workflows/ci.yml`, job `db` | — |

Verdict: APPROVE
