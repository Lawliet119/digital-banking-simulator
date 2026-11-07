# DBS-63 · UC-2 mở tài khoản, tối đa 3 tài khoản mỗi khách

> **Status:** Draft (đang bù; G1 đã duyệt, đến G2) · **Vai:** Dev (Accounts) · **Nhánh:** `feat/DBS-63-open-accounts` · **PR:** [#58 · Draft](https://github.com/Lawliet119/digital-banking-simulator/pull/58) · **Cập nhật:** 2026-11-07

> **Ghi chú quy trình:** phần implement, test và manual test của task này đã làm trước khi có G1, G2 và G3, vì yêu cầu ban đầu bỏ qua gate. Skill không cho phép việc đó. Từ đây các gate được bù lần lượt, mỗi gate một tin nhắn, người duyệt trả lời rồi mới sang gate sau. Các mục §2–§9 bên dưới là bản cũ, sẽ được viết lại ở G2 (§2–§6), G3 (§7) và G4 (§8–§9).

## 1. Bối cảnh

- **Task trên board:** Story · Tuần 2 · vai `Dev` · ưu tiên Highest · Status `In Progress` · Deliverable/Demo `P2`.
  - **Thực trạng:** Giới hạn 3 tài khoản/khách (BR-14) không biểu diễn được bằng CHECK nên phải giữ bằng transaction có SELECT … FOR UPDATE hàng customers (database-design §4.2).
  - **Expect:** Khách mở được tối đa 3 tài khoản kể cả khi bấm song song.
- **DoD** (chép nguyên văn):
  1. Endpoint mở tài khoản CHECKING/SAVINGS; kiểm số tài khoản trong transaction có khóa hàng customers
  2. Test: ≥ 5 request mở tài khoản cùng lúc → đúng 3 tài khoản, phần còn lại ACCOUNT_LIMIT_REACHED
  3. Ghi audit; số dư ban đầu 0; không thể chọn type SYSTEM từ API
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:**

  | Task | Board | Thực trạng trong repo |
  |---|---|---|
  | DBS-62 onboarding | Done | Đã vào main (`689a8e8`, [PR #56](https://github.com/Lawliet119/digital-banking-simulator/pull/56)); `customers` và `POST /v1/customers/me` có thật |
  | DBS-55 AccountsService | Done | Đã vào main ([PR #33](https://github.com/Lawliet119/digital-banking-simulator/pull/33)); không đổi chữ ký nào của `AccountsService` |

  Lúc bắt đầu implement, DBS-62 chưa merge. Người dùng đã duyệt bằng văn bản (2026-11-04) việc dựng tạm trên nhánh DBS-62 thật, không stub guard hay service, không seed customer bằng SQL. Khoảng đó đã hết: nhánh nay chứa main mới nhất.
- **Đã có gì (trên PR #58):**
  - Code: `account-opening.service.ts`, `accounts.controller.ts`, `open-account.dto.ts`, đăng ký trong `accounts.module.ts`. Test `backend/test/db/account-opening.db-spec.ts` (10 case, HTTP + PostgreSQL thật). Script manual `backend/scripts/manual-dbs63.cjs`.
  - Tài liệu: README module accounts, docs/03 (bảng API), `docs/features/README.md`, `docs/BACKLOG.md`, bằng chứng trong `screenshots/DBS-63/`.
  - Người gọi của symbol đã có: `AccountsService` giữ nguyên, không đổi export. `AccountsModule` chỉ thêm `AccountsController` và `AccountOpeningService`.
  - CI: 6/6 job xanh trên head `ec2f995` của PR (run `42169084841`), trước khi merge main mới.
- **Baseline** (cây đã merge main `aeee9c9`, commit `e06dbb1`; Node **v24.22.2** bản portable đặt ngoài repo, SHA256 đã kiểm; Postgres riêng cho e2e vì container `dbs-postgres-1` trên máy thuộc worktree khác và có mật khẩu khác, không đụng vào):

  | Lệnh | Kết quả |
  |---|---|
  | `npm run lint:check` | đạt |
  | `npm run typecheck` | đạt |
  | `npm run build` | đạt |
  | `npm test -- --runInBand` | 838/839 đạt, 56/57 suite; **1 đỏ**: `jwks-verifier.service.spec.ts` › "honours the refetch cooldown…" (đúng BL-112, đã biết, không do task này) |
  | `npm run test:e2e -- --runInBand` | 135/135 đạt, 13/13 suite (`DATABASE_URL` trỏ Postgres 17 riêng) |

  Lần chạy đầu trên Node 18.20.8 cho kết quả đỏ giả (`crypto is not defined`); không dùng. Chạy song song (không `--runInBand`) trên Node 24 cũng đỏ vì timeout khi máy quá tải, chạy riêng từng suite thì đạt. Baseline chốt là hai dòng `--runInBand`. Test DB (`test:db`) sẽ chạy ở Phase 4b.
- **Backlog liên quan (module accounts / DoD này):** BL-112 và BL-121 (test thời gian đã có, không do task này), BL-130 và BL-132 (audit từ chối vai ở tầng identity), BL-017 (test DB chạy bằng superuser nên chưa chứng minh quyền role ứng dụng), BL-122 và BL-008 (nằm ngoài). Không dòng nào được đưa vào phạm vi; task này không đóng dòng nào.
- **Ngoài phạm vi:** thay đổi schema, env, dependency hay `ErrorCode`; sự kiện mới / outbox; API khóa, mở khóa, liệt kê hay xem số dư tài khoản (các task khác); idempotency của việc mở tài khoản (FR-LED-05 chỉ nói nạp và chuyển tiền); ràng buộc DB cho giới hạn 3 (BR-14 giữ bằng khóa hàng customers, SQL của admin ngoài API không được bảo vệ).
- **Câu hỏi mở:**
  1. **Bù gate.** Code đã xong trước khi có G1–G3. Đề xuất: đi bù G1 → G2 → G3 → G4, mỗi gate một tin nhắn, dùng code hiện có làm đối tượng để duyệt, chỉ sửa code nếu review hoặc test mới phát hiện lỗi. Nếu bạn muốn làm lại từ đầu, nói rõ.
  2. **Baseline đỏ vì Node 18.** Đề xuất: chạy baseline và các test DB trong container `node:24` bằng Docker (không cài gì lên máy bạn). Hoặc bạn tự cài Node 24 rồi mình chạy lại. Chưa có kết quả này thì G4 không thể nói "đạt".
  3. **Reviewer ở G2.** Lần trước domain review dùng "Codex, cùng model", trong khi skill yêu cầu model mạnh nhất. Đề xuất: chạy lại domain review bằng một subagent mới, lưu nguyên văn đè lên `domain-review.md` (bản cũ vẫn trong git).
  4. **Nhánh và push.** Mình đã merge main vào nhánh (không rebase) để không phải force-push; conflict chỉ ở `docs/BACKLOG.md`, dòng của task đổi thành `BL-158` vì main đã dùng đến `BL-157`. Mọi thay đổi hiện chỉ nằm trên máy. Đề xuất: không push gì cho đến sau G3, và khi push thì push thường (nhánh này là của PR #58 đang mở, tác giả commit khác, nên cần bạn đồng ý).
  5. **Fixture trạng thái.** TC-63-05 dùng `UPDATE accounts SET status='LOCKED'` bằng SQL vì API khóa tài khoản chưa có. `module-notes.md` chỉ cấm seed số dư bằng SQL, không cấm trạng thái. Đề xuất: giữ, ghi rõ ở §4, không stub API khóa.

**Quyết định ở G1** (người dùng trả lời «duyệt», 2026-11-07, chấp nhận mọi đề xuất): (1) đi bù G1 → G4 từng gate trên code hiện có; (2) baseline chạy trên Node 24, thực hiện bằng bản portable thay vì container vì Testcontainers cần Docker socket; (3) chạy lại domain review bằng subagent mới ở G2; (4) không push trước G3, khi push là push thường và hỏi lại; (5) giữ fixture `UPDATE accounts SET status='LOCKED'`, ghi ở §4.

## 2. Behaviour and HTTP contract

POST /v1/accounts, existing global JWT/role guards, @Roles('customer'). Request exactly {"type":"CHECKING"} or {"type":"SAVINGS"}; IsIn only these two values, forbid extra owner/balance/status/id fields. Missing/null/non-string/lowercase/SYSTEM/SQL-like type ->400. Caller internal users.id only from @CurrentUser, server correlationId required from middleware.

201 response {"id":"<uuid>","type":"CHECKING","status":"ACTIVE","balance":"0","createdAt":"<ISO UTC Z>","updatedAt":"<ISO UTC Z>"}. Both labels behave identically. All accounts belonging to the customer count toward3, including LOCKED. No application balance conversion to Number; SQL DEFAULT0/ACTIVE used, money serialized as string. A fourth valid request ->409 with existing errorCode ACCOUNT_LIMIT_REACHED. The rejection is audited REJECTED and COMMITTED before throwing409; no extra account. Invalid DTO400 happens before service; global guard401 UNAUTHENTICATED/TOKEN_EXPIRED or403 FORBIDDEN use current contracts (role DENIED persistence remains BL-132).

Authenticated customer without onboarding ->404 (no new ErrorCode). Service returns missing from its first transaction; outside its callback calls real AuditService.recordDenied in its own transaction, action account.open, target {type:'user',id:callerUserId}, metadata{id:callerUserId}, then throws404. No nonexistent account/customer id invented. If denial audit fails,500 instead of clean404.

Audit SUCCESS action account.open targets {type:'account',id:newAccountId}, metadata{id:newAccountId}, actor verified internal userId, role customer, correlationId server UUID. Limit REJECTED same action targets {type:'customer',id:customerId}, metadata{reason:ACCOUNT_LIMIT_REACHED,count:actualCount}. Audit errors propagate and rollback insert/rejection; unexpected audit trigger errors produce sanitized500, while transient PostgreSQL errors (including lock timeout) use the existing filter's503 SERVICE_TEMPORARILY_UNAVAILABLE plus Retry-After. The same mapping applies to a denial-audit transaction. No SQL/token/PII echoed. No AccountCreated event in accepted contract; no invented event/outbox insertion.

## 3. Architecture and locking

New module-private AccountOpeningService and AccountsController/CreateAccountDto/OpenedAccountDto in accounts module. Keep exported AccountsService and its callers/signatures unchanged. Reuse real TransactionService, AuditModule/AuditService from actual dependencies. Register controller/service in AccountsModule; api/both via current registry, worker does not expose HTTP.

open(userId,type,correlationId): tx.run READ COMMITTED -> SELECT id FROM customers WHERE user_id=$1 FOR UPDATE -> if missing return missing -> SELECT count(*)::int AS count FROM accounts WHERE customer_id=$1 (all types/statuses) -> count>=3: audit REJECTED same manager, return limit -> else INSERT accounts(customer_id,type) VALUES($1,$2) RETURNING id,type,status,balance::text,... -> audit SUCCESS same manager -> return created. After tx commit: map created to201, limit to409, missing to separate DENIED audit then404. Never recordDenied inside transaction (PR54 nested-transaction protection). Do not catch a failed statement to keep using aborted transaction. No additional retry loop; tx wrapper handles deadlock/serialization.

Parent row lock serializes ONLY the same customer's openings, then a fresh statement snapshot sees prior committed accounts. Other customers are independent. Every production opening path must use this protocol; direct administrator SQL remains outside API guarantee. No account/ledger row locks needed to initialize a new zero balance account. No external I/O inside transaction. Missing server correlation context is programmer error500 before SQL.

```mermaid
sequenceDiagram
    participant C as Customer HTTP
    participant G as JWT / Roles / CurrentUser
    participant S as AccountOpeningService
    participant DB as PostgreSQL transaction
    participant A as AuditService
    C->>G: POST /v1/accounts type
    G->>S: verified userId + type + server correlationId
    S->>DB: lock own customer FOR UPDATE
    S->>DB: count all owned accounts
    alt below three
      S->>DB: INSERT default zero ACTIVE account
      S->>A: record SUCCESS with same manager
    else limit reached
      S->>A: record REJECTED with same manager
    end
    A->>DB: INSERT audit_log
    DB-->>S: commit, or rollback if audit fails
    S-->>C: 201 account or 409 ACCOUNT_LIMIT_REACHED
```

## 4. Automated cases

Full HTTP/auth-to-PostgreSQL tests in test/db/account-opening.db-spec.ts, reusing real DBS-62 startOnboardingApp, JWT issuer, migrations and temporary DB. Customer profiles created through actual onboarding HTTP, accounts only via the new API (no SQL balance/ledger seed). Pool30; Promise.all sends10 requests without awaiting each. Assert ledger invariants PASS after each business case; no funding or ledger changes. Fault trigger only in this suite's owned database, always removed in finally.

| Case | Expected and proof | Trace |
|---|---|---|
| TC-63-01 | CHECKING/SAVINGS201, exact DTO, zero string, ACTIVE, UUID/timestamps, correct own DB FK and SUCCESS audit actor/role/target/server correlationId, metadata onlyid | DoD1/3, FR-ACC-01 |
| TC-63-02 | Three sequential opens201, fourth409 ACCOUNT_LIMIT_REACHED; count3/zero, REJECTED audit persists with count3 and reason | BR-14, audit |
| TC-63-03 | Ten parallel first opens ->exact3x201+7x409 with correct code; 3 distinct ids/rows/SUCCESS audits,7 REJECTED audits; responses' correlation IDs match audits | DoD2 |
| TC-63-04 | Two customers each receive independent limit3, cannot redirect creation with forged owner fields; new request always binds caller | Ownership, BR-10 |
| TC-63-05 | Physically hold one customer's row lock; start API open, poll pg_stat_activity Lock for actual opening query before releasing; no account while blocked. Another customer's open completes while first waits. Release ->first succeeds. A LOCKED existing account still counts toward limit | Required FOR UPDATE, count all statuses |
| TC-63-06 | SYSTEM, other/missing/null/lowercase/SQL-like type and extra customerId/userId/balance/status/id400; no account or money mutation | DoD3, DTO/security |
| TC-63-07 | Missing/expired JWT401 with code, all3 staff roles403; fresh unonboarded customer404 with persisted DENIED audit targeted at user; no account | Role, dependency |
| TC-63-08 | Real audit trigger failure on successful open500 ->account rollback/count0; after trigger removal retry201. Limit audit failure500 leaves3 accounts and no false REJECTED row; denied audit failure500 instead404; recovery consistent | Fail-closed FR-AUD-01/02 |
| TC-63-09 | Swagger customer bearer/type enum/example,201 DTO and400/401/403/404/409/500/503; error409 example ACCOUNT_LIMIT_REACHED,503 SERVICE_TEMPORARILY_UNAVAILABLE with Retry-After | API docs |
| TC-63-10 | Hold actual parent customer lock until configured lock timeout; HTTP503 SERVICE_TEMPORARILY_UNAVAILABLE + Retry-After, no account/SUCCESS audit. Release lock, retry201, invariants PASS. No artificial sleep or timeout override; wait for real DB refusal | ADR-04, transient recovery |
| Process | Main-based Draft PR, actual CI checks, complete mapping; Dev review/merge remain backlog until proven | DoD4 |

Money fields never number, fraud fields absent, correlationId in problem responses, all SQL parameterized. No new resource path accepts another owner's UUID. Revocation remains real Identity guard. Idempotency-Key is not applicable: FR-LED-05 covers deposit/transfer, not account opening. TLS/env/secrets config unchanged; local owned Testcontainers only.

## 5. Manual script (before implementation)

Keep backend/scripts/manual-dbs63.cjs, run from backend after build with node scripts/manual-dbs63.cjs. Owned PostgreSQL17+temp database, actual migrations/auth/onboarding/accounts/audit, local public JWKS only; tokens/credentials never printed. Demo names Vietnamese, output real HTTP status/body/correlation IDs and safe counts/invariant result. First transcript line tested code SHA. All cleanup in finally.

| Step | Action -> expected |
|---|---|
| M-63-01 | Actual JWT, onboarding Nguyen demo profile, open CHECKING/SAVINGS ->201 zero ACTIVE and2 SUCCESS audits; DB ownership/invariants PASS |
| M-63-02 | Third open201/fourth409 ACCOUNT_LIMIT_REACHED ->3 accounts, committed REJECTED audit, balances zero |
| M-63-03 | Fresh demo profile,10 simultaneous first POSTs ->3 success7 rejection; count3/audit3+7/invariants PASS |
| M-63-04 | SYSTEM/forged owner400, no JWT401, operator403, unonboarded404 with DENIED audit; no account mutation |
| M-63-05 | Actual audit failure trigger, fresh profile open500/count0; recover/retry201; invariant PASS |
| M-63-06 | app/JWKS/temp DB/container cleanup ->no owned handles; retain raw transcript/screenshot and SHA |

## 6. Design review

First independent review: REVISE with1 should-fix: distinguish unexpected500 from transient503 and test parent-lock timeout/recovery. Addressed in section2 and TC-63-09/10. Final re-review APPROVE, no remaining findings. Read-only reviewer inherited Codex model, no override. [Round1](screenshots/DBS-63/domain-review-round1.md), [final raw reply](screenshots/DBS-63/domain-review.md).

## 7. Implementation plan

1. Resolve dependency choice; actual DBS-62 base only if explicitly approved. Retain separate DBS-63 commits.
2. Write HTTP/PostgreSQL cases first; run and record red404 for missing POST /v1/accounts.
3. Add DTO, module-private opening service with parent lock/count/insert/audit, controller and module registration. No public primitive signature changes.
4. Prove concurrency, actual lock blocking/isolation, audit commit/rollback/denial, auth/validation/OpenAPI; lint/typecheck/build/unit/e2e and relevant real DB suites. Reuse exact preceding dependency baseline checks for identical source where applicable; disclose known BL-112 local unit timing failure rather than claim green baseline.
5. Manual driver on final code commit, all six steps and actual screenshot/transcript; invariant checker after business cases.
6. Update Accounts README, docs03 POST contract, feature index/backlog and test mapping; doc link check. Commit/push per user's existing workflow. Main-based Draft PR after DBS-62 merge, then actual final CI; no stacked PR silently created.

Rollback: remove DBS-63-only commits; no schema/data teardown or shared DB revert. No migration needed. Parent locking assumes all customer-account creation follows this service; count is not a schema invariant and administrator SQL is not covered.

## 8. Results / handoff

Implemented AccountOpeningService, AccountsController and DTOs; registered in the real AccountsModule. New HTTP/PostgreSQL suite has10 cases, all passed. Four related DB suites75/75 passed (42.017s), including actual onboarding/AccountsService/AuditService. Full unit55 suites826/826 passed (190.029s); full E2E13 suites135/135 passed (158.212s). Lint/typecheck/build passed. Manual6/6 passed on code commit. No skipped task tests. Full DB suite not rerun; the four related PostgreSQL suites cover affected modules. Doc links202 files/0 broken.

Test-first evidence: after fixing a TypeScript test-helper signature (unknown body vs Supertest object), all10 tests failed as expected because POST /v1/accounts was absent (404, no OpenAPI route). Production code was written after that red run; all10 passed, then strengthened concurrent audit actor/target assertions and reran related suites75/75.

User's existing request skips gate pauses, not design review/tests/evidence. No human gate approval claimed. Existing known handoffs BL-112/121/130/132/017/122/008 remain; process dependency/PR handoff gets next free BL id at delivery if still pending.

Initial checks on main a9e607b: docker compose up -d succeeded (all3 local services running); local lint:check/typecheck passed; main CI [41840640181](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/41840640181) has6 required jobs green. Main branch deliberately has no onboarding; User explicitly approved temporary DBS-62 source via the dependency question on2026-11-04; branch fast-forwarded to7d41a51 before implementation. Separate DBS-63 branch published at handover; no PR before dependency merge, shared status edit, or test stub.

Implementation commit `eb645902758d0f6d885fa3d494aa797d33bf321d`. Manual driver executed on that commit; [raw transcript](screenshots/DBS-63/manual-test.txt), [verification summary](screenshots/DBS-63/verification.txt), [prepared PR mapping](screenshots/DBS-63/pr-description.md).

| Case / DoD | Evidence in account-opening.db-spec.ts | Result |
|---|---|---|
| TC-63-01 / DoD1/3 | Both labels, own FK, zero string/ACTIVE, exact SUCCESS audit | Matched |
| TC-63-02 / BR-14 | Third201/fourth409 and committed REJECTED audit | Matched |
| TC-63-03 / DoD2 | 10 simultaneous first requests; exactly3 distinct accounts/7 correct409; every audit actor,target,metadata,correlation verified | Matched |
| TC-63-04 / ownership | Independent limits for two customers; forged owner400 | Matched |
| TC-63-05 / locking | Observe actual pg_stat_activity Lock; other customer proceeds; LOCKED account counted (status-only SQL input fixture, no balance seed) | Matched |
| TC-63-06 / DoD3 | SYSTEM/bad types and privileged extra fields400, no accounts | Matched |
| TC-63-07 / security | Real JWT/roles,401 codes, staff403; missing profile404 and DENIED survives | Matched |
| TC-63-08 / atomic audit | DB trigger fails audit INSERT; success/rejection/denial500, account rollback and subsequent recovery | Matched |
| TC-63-09 / OpenAPI | Allowed enum, DTO/example, bearer role, success and errors incl503 | Matched |
| TC-63-10 / recovery | Real parent-lock timeout503 stable code/Retry-After, no account/audit, release/retry201 | Matched |
| DoD4 / process | BL-145 | Main-based PR/CI/Dev review/merge pending, not claimed complete |

All business cases end with actual ledger-invariant checker PASS, zero violations. Only account initialization at default zero; no funds moved, deposits/transfers synthesized or balance UPDATE.

| Manual step | Actual result on code commit |
|---|---|
| M-63-01 | CHECKING and SAVINGS201, zero string/ACTIVE; rows2/audit SUCCESS2, invariants PASS |
| M-63-02 | Third201/fourth409; count3, REJECTED audit committed, invariants PASS |
| M-63-03 | 10 real parallel POSTs ->3 success7 rejection; actual audit counts3+7, invariants PASS |
| M-63-04 | SYSTEM/forged owner400;401/403; missing onboarding404 with stored DENIED; invariants PASS |
| M-63-05 | Audit trigger fault500 rolls back account; remove trigger/retry201, zero, invariants PASS |
| M-63-06 | App/public JWKS/temp DB/owned PostgreSQL container cleaned up |

![Actual HTTP output excerpt](screenshots/DBS-63/01-http-results.png)

Historical BL-145 dependency handoff is now resolved by rebase after PR56 merge; current PR/CI/review state is recorded in the final handover below. No PR against dependency branch, board edit or auto-merge. BL-145 remains open only for final CI/Dev review/merge.

Historical pre-merge fetch2026-11-04: PR56 was still open/unmerged and origin/main a9e607b. [Published DBS-63 branch](https://github.com/Lawliet119/digital-banking-simulator/tree/feat/DBS-63-open-accounts). At that historical handoff no GitHub CI/Dev review/merge was claimed for DBS-63; see current handover below. Delivery checklist: design/re-review APPROVE, all ten planned cases matched, local automated checks and six manual steps complete; raw output inspected for credential markers and screenshot visually checked; source SHA recorded; no schema/env/dependency/ErrorCode/ADR/event change. Current final CI and Dev review/merge tracked in BL-145; main PR is now authorized by the follow-up request.

## 9. Sources and changed docs

Exact sheet DBS-63; docs02 UC-2, FR-ACC-01, BR-14, FR-AUD-01/02; docs03 API/error table; shared database-design4.2, event-contract; Accounts/Audit README, actual schema/TransactionService/AuditService, CONTRIBUTING5/5b. Updated Accounts README and docs03 POST API contract, this feature doc, feature index, BACKLOG BL-145 and raw review/test/manual evidence. Public primitive exports and schema unchanged.

## Rebase and final handover ? 2026-11-06

User requested completion after DBS-62 merge. Independently verified PR56 merged into main689a8e8 (GitHub API), then replayed ONLY commits after7d41a51 onto main2df7d0a. Rebasing application code/tests/manual driver caused no conflicts and byte-for-byte task source is unchanged. Resolved BACKLOG/feature-index conflicts by retaining main rows plus DBS63 own row; no duplicate DBS62 row or inherited commits in PR. Rebased source commit a69bfcf; tested tree/manual HEAD b9e68eb includes only later documentation. Manual re-executed6/6 on that exact tree, raw firstline SHA records it. Automated check results, new PR and final CI appended below once observed. No human Dev review/merge claimed; board changes remain with user.

Rebased-tree checks2026-11-06: lint/typecheck/build PASS; full unit56 suites832/832 PASS(50.551s), full e2e13 suites135/135 PASS(83.168s), manual6/6 PASS at b9e68eb. Initial related-DB command had a filename typo(audit-service instead of actual audit.service),62 actual cases passed but command failed ENOENT; corrected command rerun and final result recorded below. Never treated ENOENT as suite success. No task test skips.

Final corrected related-DB command: four suites75/75 PASS(10.185s), including all10 account-opening cases and real parent-lock503/recovery. Full DB suite remains for PR CI; selected75 not claimed fullDB.

Opened [Draft PR58](https://github.com/Lawliet119/digital-banking-simulator/pull/58), base **main**. Final required jobs lint/typecheck/build/unit/e2e/db tracked in [Checks](https://github.com/Lawliet119/digital-banking-simulator/pull/58/checks); actual result verified before handover. Local checks above do not replace CI. Another Dev review and merge pending BL-145. User can move board to In Review after this main-based handover; agent does not edit sheet or merge. Final docs link check209 files0broken.
