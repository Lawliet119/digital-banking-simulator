# Domain review vòng 1 (nguyên văn)

Reviewer: subagent general-purpose, Opus 5.5, 2026-11-07. Prompt: `prompts/domain-review.md`, có thêm mục kiểm skill và backlog.

| # | Mức độ | Mục trong doc | Phát hiện | Bằng chứng | Đề xuất sửa |
|---|---|---|---|---|---|
| 1 | blocking | §2.1 A-11, A-09, §1 DoD 5 (danh sách sửa board), TC-CHORE-04 | Điều kiện đóng của khoảng 21 dòng là "Dev khác review, CI xanh, merge main". Phần review **chưa đạt ở bất kỳ PR nào**. Cả 26 PR đã merge đều có `reviews=0` và 0 comment. 11 PR do chính tác giả tự merge (#7, 8, 9, 10, 11, 17, 29, 46, 47, 48, 54). 15 PR còn lại do Lawliet119 merge nhưng cũng không có review nào được ghi. Trong số đó có các PR đi trên đường tiền: #8 (ledger), #17 (trigger append-only), #57 (nạp tiền), #61 (chuyển tiền). Nếu xóa các dòng này, đổi Status thành "Implemented · PR #N (merged)" và đưa ô board "Done", ta sẽ xóa dấu vết duy nhất của việc thiếu review. Điều đó trái CONTRIBUTING §1 mục 4 và §1b ("Done" chỉ khi DoD đạt). TC-CHORE-04 chỉ kiểm phần merge nên sẽ xanh sai. | `gh pr view <n> --json author,mergedBy,reviews,comments`; `docs/BACKLOG.md` BL-020, 022, 025, 030, 052, 054, 057, 124, 126, 131, 134, 135, 137, 139, 141, 142, 144, 149, 150, 151, 153; CONTRIBUTING §1 mục 4, §1b | Chỉ xóa phần "chờ merge" khi đã kiểm bằng `gh`. Gộp phần review còn thiếu vào **một dòng BL mới**: liệt kê từng PR kèm author và mergedBy, PR đường tiền đứng đầu. Điều kiện đóng: có review GitHub của một Dev khác tác giả (review sau merge vẫn tính). Status của feature doc ghi "PR #N đã merge, chưa có Dev review". Bảng board ở §8 không đề xuất "Done" khi DoD có bullet review, chỉ báo cho người dùng biết. TC-CHORE-04 phải kiểm cả `reviews[].author != author`. |
| 2 | blocking | §2.2 B-02(a) | "Đỏ do môi trường máy, CI trên `main` xanh, đã tìm ra nguyên nhân thì ghi lại và đi tiếp" bỏ được điểm dừng ở G1 mà không cần duyệt theo tên. Nó cũng không bắt các suite đỏ phải xanh trước G4. "Docker không chạy" thỏa đúng câu chữ (a), nên agent có thể tới G4 mà chưa lần nào thấy money test (`test:db`: customer-transfers, operator-deposits, invariants) xanh ở local. Điều này mâu thuẫn trực tiếp với testing.md. | SKILL.md Phase 1 bước 6 ("A red baseline is reported at G1, not built on"); `references/testing.md` §Layers ("Docker down means the money tests are **not run**… never skipped into a green result"); `backend/test/db/*.db-spec.ts` | Với (a) vẫn phải nêu từng test đỏ ở G1 và người duyệt chấp nhận theo tên. Trước G4, chính các test đó phải xanh trong môi trường đúng hoặc trên CI của head PR (Draft sau G3), kèm link run. Không áp dụng (a) cho test mà task thêm hoặc sửa. Docker không chạy không bao giờ thuộc (a). |
| 3 | blocking | §2.2 B-11 | Lựa chọn "ghi retroactive và đánh dấu không đỏ cho TC chưa từng đỏ" cho phép giữ code viết trước test, kể cả code tiền. Một test chưa từng đỏ có thể rỗng. Rule này hợp thức hóa đúng tiền lệ của DBS-61 (chuyển tiền, "G1–G3 làm bù"). | SKILL.md 4a ("Code written before its test is deleted and rewritten from the test"); `docs/features/DBS-61-customer-transfers.md` dòng Status | Giữ mặc định là xóa rồi viết lại. Nếu người duyệt chọn retroactive theo tên ở gate, mỗi TC phải có **đỏ bằng mutation**: tạm hoàn tác hoặc làm hỏng đúng dòng nó bảo vệ, chạy thấy đỏ, ghi lệnh và output vào §8. Cấm "không đỏ" cho code thuộc CONTRIBUTING §5 (ledger, số dư, idempotency, audit). |
| 4 | should-fix | §2.2 B-10 | Bullet chỉ là quy trình (review, merge) không còn thành dòng BL. Như vậy cơ chế duy nhất theo dõi việc "Dev khác review" biến mất (xem #1), trong khi GitHub không ép approval. Template G4 vẫn ghi "mọi DoD chưa đạt… có dòng BL-NNN", nên hai file mâu thuẫn. Vế "PR đã có trên `main` thì xóa" cũng lẫn "đã merge" với "điều kiện đóng đạt". | `templates/feature-doc.md` checklist G4 dòng cuối; SKILL.md Phase 5 bước 2; CONTRIBUTING §1 mục 4 ("không ép số approval") | Nếu bỏ dòng BL cho bullet quy trình thì Phase 5 bước 3 phải bắt agent báo người dùng: board chỉ chuyển "Done" sau khi `gh pr view --json reviews` có review của người khác tác giả. Sửa cả checklist G4. Chỉ xóa dòng BL khi **toàn bộ** điều kiện đóng đã kiểm. |
| 5 | should-fix | §2.2 B-08 (dòng docs nhiều file) | "Domain review chỉ khi đổi fact nghiệp vụ hoặc kiến trúc" biến một bước bắt buộc của G2 thành tùy chọn mà không sửa SKILL. Agent sẽ thấy hai quy tắc trái nhau. | SKILL.md Phase 2 ("AI domain review, mandatory"); Red flags ("Too small for a domain review") | Giữ domain review bắt buộc. Nếu muốn nới thì sửa luôn SKILL Phase 2 với tiêu chí kiểm được. docs/03, threat model và ADR luôn tính là có đổi fact. |
| 6 | should-fix | §2.2 B-01 | B-01 bỏ sót `task-kinds.md`. Dòng "Endpoint or service" vẫn ghi "then the four commands", và các dòng "same" kế thừa từ đó. Sửa xong vẫn còn một chỗ nói 4 lệnh, không có `test:db`. | `references/task-kinds.md` dòng 7 | Thêm `task-kinds.md` vào B-01. TC grep "four commands\|bốn lệnh" trên `.claude/` phải rỗng sau khi sửa. |
| 7 | should-fix | §3 (người dùng `.agents/`), B-03 | §3 nói `.agents/` "chỉ được nhắc trong DBS-53, DBS-69 và commit b2bb5bc". Thật ra người dùng là chính Codex: `.agents/skills/` là chỗ Codex tìm skill của repo. Commit b2bb5bc của ducp8822 có tên "add codex skills", và PR #35 dùng nhánh `codex/…`. Xóa đi thì phiên Codex không còn tự nạp skill, chỉ còn AGENTS.md. | `git show --stat b2bb5bc`; `gh pr view 35` headRefName `codex/DBS-69-ledger-invariants` | Sửa câu ở §3. B-04 phải ghi AGENTS.md là đường bắt buộc cho **mọi** thay đổi, không chỉ khi có `DBS-<n>`. Báo ducp8822 trong mô tả PR B. |
| 8 | should-fix | §4 TC-CHORE-03 | Regex `chờ (review\|merge)` chỉ bắt 4 trên 12 dòng Status cũ (DBS-40, 55, 61, 69). Nó bỏ sót "chờ Dev review", "chờ CI/review", "chờ CI, review" ở DBS-41, 42, 57, 58, 59, 60, 62, 71. Test có thể xanh khi A-09 mới làm một nửa. | Đã chạy regex của TC trên `docs/features/*.md` | Dùng `^> \*\*Status:\*\*.*(chờ\|chưa push\|Draft PR)` (đã thử: bắt đủ 12). Giữ thêm kiểm "mọi doc có `> **Status:**`" vì DBS-76 và DBS-77 dùng "Trạng thái:". |
| 9 | should-fix | §4, §5 (độ phủ DoD 4, DoD 5) | Các thay đổi skill rủi ro nhất (B-02, B-10, B-11, B-08) không có case nào. M-SKILL-02 chỉ thử key, việc từ chối sửa board và `test:db`. DoD 5 (bảng sửa board) không có TC hay bước thủ công. | §4, §5 của doc | Thêm kịch bản áp lực: (iii) "Docker không chạy, test:db đỏ, làm tiếp đi"; (iv) "code chuyển tiền đã viết sẵn, chỉ cần viết test". Ở GREEN agent phải dừng hoặc đòi đỏ bằng mutation. Thêm bước kiểm bảng board của §8 với `gh pr view` cho từng dòng. |
| 10 | should-fix | §2.2 B-07 | Mở rộng key ngoài board (CHORE, DOCS, SKILL) mà không giữ bước "hỏi key board trước". CONTRIBUTING §1 ("Mỗi việc là một task `DBS-n`") và §2 (`<loại>/DBS-<n>-…`) không được sửa theo, nên hai nơi mâu thuẫn và việc ngoài board dễ thoát khỏi board. | `references/task-kinds.md` "No board key: ask for one"; CONTRIBUTING §1, §2 | Giữ câu "hỏi key trước". Thêm vào A-02 một dòng về key ngoài board. Thêm mẫu `FRAUD-API-NN` hiện có cho khớp B-13d. |
| 11 | should-fix | §2.1 A-01, A-11, A-12 | Nội dung của các thay đổi này phụ thuộc "câu hỏi G2 #1, #2", nhưng các câu hỏi đó không có trong doc. Thiết kế cần review không đọc được. | §2.1 của doc | Ghi câu hỏi và đề xuất vào §2. Câu #1 phải xử lý theo phát hiện #1. |
| 12 | minor | §2.1 A-08 | Dễ ghi quá mức: T10 gồm cả khóa tài khoản và kết luận cờ (chưa có endpoint). T11 còn BL-132 mở (403 của `RolesGuard` không ghi `audit_log`). T12 hiện mới có kiểm sở hữu của transfers. | `docs/security/threat-model.md` T10–T12; controller hiện có trong `backend/src/modules/*/*.controller.ts` | Ghi rõ trạng thái đích từng dòng là "Một phần: <test>". Không đặt "Đã kiểm" khi chưa có task security (DBS-86, 158, 159). |
| 13 | minor | §2.1 A-05 | "Relay chạy ở `worker`" là sai nếu viết như fact hiện tại: relay chưa có code (`workerModules = []`, có comment "added by #3"). Sửa docs/03 cũng chưa thêm dòng v1.8 vào §21, và Owner "#1" ở dòng Status vẫn còn. | `backend/src/modules/index.ts:32`; `backend/README.md:140` ("Relay/consumer chưa có"); docs/03 dòng 3, §21 | Viết "relay (chưa có code) sẽ chạy ở worker". Thêm v1.8 vào §21. Sửa Owner. Render lại sơ đồ mermaid §5. |
| 14 | minor | §2.1 A-03 | "Role `worker` hiện chưa có module" là sai. Worker vẫn nạp `sharedModules` (Outbox, Audit, Risk). Ngoài ra dòng 8 của backend/README liệt kê relay, risk scoring, notification như đã có. | `backend/src/modules/index.ts:21-41`; `backend/README.md:8` | Viết "`workerModules` rỗng; worker chỉ nạp module dùng chung, chưa có consumer hay relay". |
| 15 | minor | §2.1 A-01, A-02 | Bỏ sót hai fact CI. Job `unit` còn chạy `node --test ../load-tests/fraud-dataset/generate.test.mjs`. Job `e2e` chạy một phần `test:db` trên Testcontainers. Bảng §4b chỉ ghi `npm test` và `test/**/*.e2e-spec.ts`. | `.github/workflows/ci.yml` job `unit`, `e2e` | Thêm hai fact vào CONTRIBUTING §4b và README dòng 81. |
| 16 | minor | §2.1 A-02 | Bỏ "#1 duyệt" ở CONTRIBUTING §7 mà không ghi ai thay thế, nên việc duyệt ADR thay thế không còn người chịu trách nhiệm. | CONTRIBUTING §7; `references/team.md` (không còn #1) | Thay bằng người duyệt cụ thể, ví dụ "cả nhóm duyệt qua gate phụ của skill". |
| 17 | minor | §2.1 A-14, A-11 | A-14 đạt một nửa điều kiện đóng của BL-136 ("không còn script ký token trong `dist/`"), nhưng A-11 không thu hẹp BL-136. | `docs/BACKLOG.md` BL-136 | Thu hẹp BL-136 còn phần chuyển sang `createDevTokenIssuer` hoặc `test/manual/`. |
| 18 | minor | §2.1 A-17 | Ranh giới module của eslint chỉ áp cho `src/**`. `test/db/audit.service.db-spec.ts` có đúng kiểu import sâu này nhưng không được sửa. Không có case nào chứng minh alias chạy được lúc runtime với `ts-node -r tsconfig-paths`. | `backend/eslint.config.mjs` (`files: ['src/**/*.ts']`); `backend/test/db/audit.service.db-spec.ts:5-6` | Bỏ A-17, hoặc sửa mọi file cùng kiểu và chạy lại `audit-record.manual.ts` một lần. |
| 19 | minor | §4 TC-CHORE-02 | Sau khi sửa không thể rỗng nếu không sửa cả lịch sử. Pattern khớp dòng changelog docs/03 §21 v1.6 ("chuyển 13 ADR sang Accepted"), `docs/adr/README.md:3` và DBS-53, DBS-75. Cụm "features/ cũ" không định nghĩa được. | `git grep` với đúng pattern của TC | Liệt kê chính xác file nằm trong phạm vi. Loại trừ §21 và feature doc theo đường dẫn. |
| 20 | minor | §2.1 A-13 | `load-tests/README.md` vẫn còn "Phụ trách: #6" (vai này không còn), A-13 không sửa. | `load-tests/README.md:3`; `references/team.md` | Thêm vào A-13. |
| 21 | minor | §5 | PR A không có bước từ chối hay biên, ví dụ một link anchor `_` hỏng phải bị `check-doc-links` báo, hay một key không hợp lệ phải exit 2. Kết quả mong đợi của `--next` thì phụ thuộc trạng thái board. M-CHORE-02 không nêu env cần cho `node dist/main.js` (`env/.env.development`, `AUTH_MODE`). | §5 của doc; `backend/src/config/validation.schema.ts` | Thêm một bước âm cho mỗi PR. Ghi rõ env của M-CHORE-02. |

Verdict: REVISE

---

# Domain review vòng 2 (nguyên văn)

Reviewer: subagent general-purpose mới, Opus 5.5, 2026-11-07.

I re-checked all 21 round-1 findings and the new design sections against the code, CI, `gh` data and open PRs. The decisive problem is option (b) in G2 #1. In 24 of the 26 "Nhóm 2" PRs, the person who merged (Lawliet119) also wrote commits, including money-path fixes. If (b) is adopted, that unreviewed money code would be recorded as reviewed.

**Item 1: round-1 findings**

| # | Status | Note |
|---|---|---|
| 1 | partially | BL-158 is added. But the recommended (b) takes Nhóm 2 out of BL-158, and Nhóm 2 holds the money PRs #57 and #61 that finding #1 named. See new finding N1. |
| 2 | fixed | The environment exception is now tight. B-02 adds a second exception ("đỏ có sẵn đã có BL"), see N4. |
| 3 | fixed | Mutation-red and the money ban are in. The ban's scope is vague, see N6. |
| 4 | fixed | Conflicts with (b), see N2. |
| 5 | fixed | |
| 6 | fixed | `task-kinds.md:7` and the template's "bốn lệnh" (`feature-doc.md:12`) are both covered by B-01. TC-SKILL-06 can go red. |
| 7 | fixed | b2bb5bc is the squash of PR #30 (ducp8822), confirmed. |
| 8 | fixed | The regex matches 12. One of them shows as "Binary file matches" (see N14). |
| 9 | fixed | |
| 10 | partially | Only CONTRIBUTING §1 and §2 get the off-board key. §3b, the §4 checkbox and the PR template ("Task: DBS-") still say DBS only. |
| 11 | fixed | |
| 12 | fixed | |
| 13 | partially | The new Owner value is not stated. The mermaid diagram in §5 still shows the relay as if it exists ("Không sửa sơ đồ"). |
| 14 | fixed | Verified: `modules/index.ts:21-34`. |
| 15 | fixed | Verified: `ci.yml:79` and `ci.yml:123-132`. |
| 16 | partially | "Cả nhóm duyệt qua gate phụ" is wrong: the extra gate is approved by the one human in the session (SKILL.md:25). |
| 17 | fixed | |
| 18 | fixed | |
| 19 | partially | `git grep` cannot exclude "docs/03 trừ §21". `docs/03:12` "ADR-01…13" is matched but no A-05 change covers it. |
| 20 | fixed | |
| 21 | partially | M-CHORE-06 cannot go red as written (N7). M-CHORE-02 cannot start as written (N10). |

**Item 2: findings, most severe first**

| # | Severity | Section | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| N1 | blocking | §2.1 G2 #1 (b), A-11, A-09 | Nhóm 2 is grouped by the PR `author` field only. In 24 of the 26 Nhóm 2 PRs, the merger Lawliet119 also wrote commits. Examples: #61 `f976102 fix(ledger): do not lock the funding account on transfers` and more fix/test commits; #33 `bf23e51 fix(accounts)…`; #12 and #13 test commits; #56 and #57. Under (b), these money PRs would count as "Dev review" although nobody but their own authors ever looked at the final code. The counts are also wrong: 48 PRs are merged, not 52. Nhóm 1 (13) + Nhóm 2 (26) = 39, so #1, 2, 3, 4, 5, 6, 20, 28 and 30 are in neither group and no exclusion rule is stated. #5 and #6 changed the delivery skill itself. | `gh pr list --state merged --json author,mergedBy,reviews` (48 rows, all `reviews=0`); `gh pr view 61 --json commits` (authors include Lawliet119); the same for #12, 13, 33, 34, 35, 56, 57 | Group by "merger ∉ {PR author} ∪ {commit authors}". All money PRs (#8, 12, 13, 17, 21-era migrations, 33, 34, 35, 56, 57, 61) stay in BL-158 under either option. Fix the counts and state the docs/skill PR filter explicitly, or include those PRs. |
| N2 | should-fix | G2 #1 (b) vs B-10, TC-CHORE-04, G2 #4 | (b) contradicts the rest of the design. (1) B-10, TC-CHORE-04 and Phase 5 step 3 check `reviews[]` on GitHub, while (b) says a merge counts as review. (2) `team.md:15` and CONTRIBUTING §1 item 4 ("không tự merge khi chưa có Dev khác để lại review") are not edited. (3) G2 #4 puts DBS-61 (#61) and DBS-76 (#52) "In Review… chờ Dev review (BL-158)", but both are in Nhóm 2, so under (b) they are not in BL-158. | `references/team.md:15`; CONTRIBUTING §1.4; design §2.1 #1 and #4 | Pick one rule and apply it to all six places. With N1's fix, #61 and #52 stay in BL-158 anyway. |
| N3 | should-fix | A-11 BL-158; skill hole not covered by any B-xx | BL-158 is already taken by open PR #58 (DBS-63, updated today). Open PR #62 adds a second BL-151 that clashes with main's BL-151 (DBS-76). "Next free `BL-NNN`" in SKILL Phase 5 step 2 does not look at open PRs, so this is a real skill hole. | `gh pr diff 58` (`+| BL-158`, `+| BL-159`); `gh pr diff 62` (`+| BL-151`); `docs/BACKLOG.md:104` | Use BL-160 or higher. Add a B-xx: before taking an ID, check `gh pr list --state open` diffs for `^\+\| BL-`, or reserve ID ranges. Also flag the clashes with PR #45 (BL-053) and PR #62. |
| N4 | should-fix | B-02, last sentence | "Đỏ có sẵn đã có dòng BL thì được đi tiếp chỉ khi G1 duyệt theo tên" is a second exception. It has none of the limits of the first: no "phải xanh trước G4", no exclusion of money tests or of tests the task touches. A known-red `test:db` money test with a BL row could reach G4 red. Today SKILL.md:50 has no such exception. | SKILL.md:50; `references/testing.md:13` | Add the same limits: never for `test:db` or tests the task touches, and the red set must not grow. Show this on CI of the head PR. |
| N5 | should-fix | B-08 (Refactor row) | "Một test giữ nguyên hành vi" is accepted as the red step. A characterization test never goes red, so this is a TDD exemption without B-11's mutation rule, and it also applies to money refactors (BL-157 is exactly that). | SKILL.md 4a; B-11 | Require mutation-red for characterization tests, as in B-11. Refactors in money paths keep the full CONTRIBUTING §5 rules. |
| N6 | should-fix | B-11 | The retroactive ban is scoped "CONTRIBUTING §5 (ledger, số dư, idempotency, audit)". §5 does not define that list, so it cannot be checked. It leaves out auth guards (`identity` JWT/RolesGuard), `accounts`, `outbox`, migrations and append-only triggers. | CONTRIBUTING §5; `backend/src/modules/*` | Define the ban by path: `modules/{ledger,accounts,audit,outbox,identity}`, `database/migrations`, `common/money`. |
| N7 | should-fix | §5 M-CHORE-06; B-14 | (1) `[x](#44-ledgerentries)` with no path points at the draft file itself, which has no such heading. It is broken before and after B-14, so it tests nothing. (2) It sits under PR A, but the slug fix is in PR B; with the current script, `database-design.md#44-ledgerentries` passes. (3) B-14 will break an existing link that no A/B row lists: `backend/src/modules/audit/README.md:7` → `database-design.md#47-auditlog`. Unplanned file = extra gate. | `check-doc-links.mjs:15-17`, `:43`; `database-design.md:208`, `:280` | Move the step to PR B. Link `docs/components/_shared/database-design.md#44-ledgerentries` (expect broken) and `#44-ledger_entries` (expect OK). Add the audit README link fix to B-14. |
| N8 | should-fix | G2 #4 | Tasks in the same state get different board proposals. DBS-60 (#57 deposits) and DBS-62 (#56 onboarding idempotency) stay "Done" with 0 reviews, while DBS-61 goes back to In Review. CONTRIBUTING §1b says Done only when the DoD is met. | CONTRIBUTING §1b; `gh pr view 57/56 --json reviews` (0) | Treat them the same: propose In Review for every money-path task in BL-158, or at least mark the Done rows as "DoD chưa đạt (BL-158)". |
| N9 | should-fix | B-13a/b | The probe stops only when a missing tab returns a sheet without `Issue Key`. That depends on how the spreadsheet's tabs are ordered (unverified). The "Tài liệu đã chốt" tab has different columns (`fetch-task.mjs:86`). If `isBoardTab` rejects it, B-13b (missing = not Done) would mark every dependency on an archived task as blocking. Today missing deps count as Done (`:61`). | `fetch-task.mjs:9`, `:61`, `:86` | Cap the probe (for example 30 tabs or a repeated payload). Handle the archive tab explicitly. Add a TC with an archive-tab fixture. |
| N10 | minor | §5 M-CHORE-02 | Cannot start as written. `AUTH_MODE=local` makes `AUTH_LOCAL_JWKS_PATH` required, and it is commented out in `.env.example`. Also `NODE_ENV=development` loads `env/.env.development`, which does not exist in this worktree. | `validation.schema.ts:147-155`; `env/.env.example:70-71`; `load-env.ts:15` | Name `AUTH_LOCAL_JWKS_PATH=.auth-local/jwks.json`, or copy `.env.example` to `env/.env.development` and uncomment it. |
| N11 | minor | §4 TC-CHORE-02, A-05 | "docs/03 trừ §21" cannot be done with `git grep`. `docs/03:12` "ADR-01…13" (header table) is matched, but no A-05 change covers it. | Ran the pattern: matches at `docs/03:12` and `:1034` | Pipe `sed '/^## 21/,$d'` before grep. Add line 12 to A-05. |
| N12 | minor | A-10, G2 #1 | Wrong numbers. Push-main runs are 35 of 36 green (1 failure, 82c8e23 on 2026-10-26), not 29 of 30. Merged PRs are 48, not 52. The "two merges close together" condition of BL-014 is met: 6138741 and b2bb5bc ran 37 s apart, both green. | `gh run list --workflow ci.yml --event push --branch main` | Fix the numbers and cite that pair as BL-014 evidence. |
| N13 | minor | A-02 | CONTRIBUTING §4 item 2 still requires all 5 commands green locally, which contradicts the B-02 exception (CI head-PR link). §3b, the §4 checkbox and the PR template still say DBS-only (round-1 #10). | CONTRIBUTING §3b, §4; `.github/pull_request_template.md` | Add both to A-02. |
| N14 | minor | TC-CHORE-03 | `DBS-57-outbox-writer.md:560` contains a control character, so grep prints "Binary file matches" instead of the line. The "≥ 12" count depends on that. | `grep -naP '[\x00-\x08…]'` | Use `grep -a`. Optionally remove the stray character under A-09. |
| N15 | minor | B-12 | An endpoint driver script is allowed, but nothing says it must call the running app over HTTP. A script that calls the service in-process is not a manual test of the endpoint. | `task-kinds.md:7`; `backend/scripts/manual-dbs6x.cjs` | Add "qua HTTP tới app đang chạy, in status, headers and body". |

**Item 3: G2 #1 option (b), "Dev khác tác giả merge = Dev review"**

Not acceptable as written for a banking codebase.

- A merge leaves no record of what was examined.
- The PR `author` field is not the code author: here the merger wrote the final ledger fixes in #61.
- (b) would apply backwards and clear past money PRs that have no review artefact.
- The person who would approve (b) is the person whose merges it would turn into "reviews".

Minimum conditions for it to be acceptable:
1. **Forward-only.** It applies to PRs merged after the rule's date. Every past PR stays in BL-158, which means option (a) for history.
2. **Merger did not write the code.** The merger is neither the PR author nor the author of any non-merge commit in the PR (`gh pr view --json commits`).
3. **Recorded review before merge.** The merger leaves a GitHub review (Approve, or Comment with the test-case table checked) before merging.
4. **Money paths need an Approve.** For CONTRIBUTING §5 paths (ledger, accounts, audit, outbox, identity guards, migrations), an Approve from such a Dev is required. The cheap way to enforce this is a ruleset with required approvals = 1 and "require approval of the most recent push".

Without conditions 2 and 3, (b) should be rejected in favour of (a).

Verdict: REVISE


---

# Domain review vòng 3 (nguyên văn)

Reviewer: subagent general-purpose mới, Opus 5.5, 2026-11-07.

**Mục 1: các phát hiện của vòng 1 (đánh dấu "partially" ở vòng 2) và vòng 2**

| # | Trạng thái | Ghi chú |
|---|---|---|
| 1 | fixed | BL-160 bản nghiêm ngặt đã có, bỏ (b), số 48 đúng. Còn lỗi phân loại và thứ tự PR trong BL-160 (xem F1, F2). |
| 10 | fixed | A-02 đã phủ §1, §2, §3b, checkbox §4 và dòng "Task:" của PR template. Còn sót dòng 6 và 33 của template (F10). |
| 13 | fixed | Owner đổi thành "Dev"; ghi chú dưới sơ đồ §5; có dòng 12, §18, §21 v1.8. |
| 16 | fixed | §7 ghi "người duyệt gate phụ trong phiên + một Dev khác review PR", khớp SKILL.md:25. |
| 19 | fixed | Đã chạy pattern trên tree hiện tại. Mọi chỗ khớp (README:42/55/97, CONTRIBUTING:133, backend/README:69, libs/README:9, docs/README:22, load-tests:3, docs/03:12) đều có dòng A-xx sửa. Phần `sed` loại §21 dùng được. |
| 21 | fixed | M-CHORE-06 đỏ được (file không tồn tại, script cũ báo MISSING). M-CHORE-02 đã đủ env. |
| N1 | fixed | Bỏ (b), nhóm theo người viết commit. Phụ: số "24 PR" sai, xem F2. |
| N2 | partially | B-10 viện dẫn CONTRIBUTING §1.4 và `team.md:15` nhưng hai file này không nói điều kiện đó (F5). Phương án (Y) của G2 #4 mâu thuẫn với B-10 Phase 5 bước 3 (F3). |
| N3 | fixed | Đã kiểm diff của 9 PR đang mở: số lớn nhất là BL-159 (#58), nên BL-160 còn trống. Có B-17. |
| N4 | partially | Đã có giới hạn, nhưng ngoại lệ chỉ loại theo lệnh (`test:db`). Money test còn nằm ở `npm test` và `test:e2e` (F6). |
| N5 | partially | Mutation-red chỉ áp "nếu dùng" characterization test. Câu "theo đủ CONTRIBUTING §5" không thêm yêu cầu test nào (F8). |
| N6 | partially | Đã liệt kê theo đường dẫn nhưng thiếu `database/transaction.service.ts` và `transaction.helper.ts` (F7). |
| N7 | fixed | M-SKILL-04 ở PR B, dùng đường dẫn đầy đủ. Slug cũ cho `ledgerentries` qua, slug mới cho `ledger_entries` qua. Link `audit/README.md:7` `#47-auditlog` đã nằm trong B-14. |
| N8 | partially | (Y) áp đều, nhưng gắn nhãn "chỉ thiếu review" cho cả task còn DoD khác chưa đạt (F4). |
| N9 | fixed | Có chặn 30 tab, dừng khi nội dung trùng, tab lưu trữ đọc riêng, có TC. Phụ: xem F9. |
| N10 | fixed | Có `AUTH_LOCAL_JWKS_PATH` và bước chép `.env.development`. |
| N11 | fixed | Có `sed '/^## 21/,$d'`; A-05 đã phủ dòng 12. |
| N12 | fixed | Đã kiểm: 36 lần chạy push main, 35 xanh, 1 đỏ (82c8e23); run 42325275992 xanh; 48 PR. |
| N13 | fixed | A-02 có §4 mục 2 và §3b. |
| N14 | fixed | Có `grep -a` và xóa ký tự lạc. |
| N15 | fixed | B-12 bắt gọi qua HTTP tới app đang chạy, in status, headers, body. |

**Phát hiện mới**

| # | Severity | Section | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| F1 | should-fix | §2.1 G2 #1 (thứ tự BL-160) | Danh sách "PR trên đường tiền đứng đầu" (#8, 12, 13, 17, 33, 34, 35, 56, 57, 61) không khớp với danh sách đường dẫn của chính B-11. Bỏ sót: #7 (migration đầu tiên users/customers/accounts), #9 (toàn bộ `common/money`: Money, balance), #44 (migration fraud + `append-only`), #54 (`modules/audit` service), #16 (`transaction.service.ts`, `common/money`), #29, 46, 47, 48 (`modules/identity`: guard và JWT). Code tiền cốt lõi (#9) sẽ được review sau. | `gh pr view <n> --json files` cho 48 PR, lọc theo regex đường dẫn của B-11 | Sinh danh sách bằng máy từ đường dẫn của B-11 (cộng F7). Ghi lệnh vào TC-CHORE-04 hoặc M-CHORE-05. |
| F2 | should-fix | §2.1 G2 #1 (dòng con docs/skill, số đếm) | Gọi "#1–6, 20, 28, 30 chỉ đổi docs hoặc skill" là sai. #1 đổi `config/validation.schema.ts` (+8/-6) và spec. #2 thêm mã vào `common/errors/error-code.enum.ts` và sửa `.github/pull_request_template.md`. #4 sửa `backend/env/.env.example` và `infra/terraform/README.md`. #3, 5, 6, 20 cũng chạm `backend/` hoặc `.github/`. Vậy quy tắc "đổi `backend/`, `infra/`, `.github/`" và dòng con chồng lên nhau, còn #1, #2 có code production. Thêm nữa: số "24 PR do tác giả khác mở, người merge có commit" cũng sai. Thực tế 29 PR do tác giả khác mở, Lawliet119 có commit ở 22 PR trong đó. | `gh pr view 1,2,4 --json files`; tính trên `--json author,commits` | Chỉ dòng con những PR không đổi file nào ngoài `*.md` hoặc `.claude/`, tức #28 và #30. Chuyển #1 và #2 lên danh sách chính. Sửa số đếm thành 29 và 22. |
| F3 | should-fix | G2 #4 (Y), A-02 §1b so với B-10 Phase 5 bước 3 | (Y) thêm vào §1b một dòng "đã merge, DoD review chưa đạt thì Done", trong khi B-10 bắt agent báo "board chỉ chuyển Done khi review đã có trên GitHub". Dòng §1b không giới hạn thời gian, nên áp cả cho PR sau này. Mọi PR mới merge không review sẽ thành Done kèm ghi chú, và CONTRIBUTING §1.4 mất tác dụng. Hai PR A và B sẽ chứa hai quy tắc trái nhau. | CONTRIBUTING §1b, §1.4; design B-10, A-02, G2 #4 | Giới hạn dòng §1b cho PR đã merge tới `aeee9c9` (lịch sử). Ghi rõ B-10 áp cho mọi PR sau đó. Hoặc nếu muốn (Y) áp cả về sau thì sửa B-10 cho khớp. |
| F4 | should-fix | G2 #4 (Y), M-CHORE-05 | Ghi chú của (Y) chỉ nói "DoD review chưa đạt (BL-160)". Nhưng DBS-61 còn BL-154 (hạn mức, AC-5.6), BL-155 (rate limit), BL-156 (AC-5.9 chưa kiểm đủ). DBS-53 còn BL-135 (M-53-09 chưa chạy, BL này giữ lại sau khi thu hẹp). Chuyển các task này sang Done chỉ kèm ghi chú review sẽ giấu DoD khác chưa đạt, trái §1b. | `docs/BACKLOG.md:93,107-109` | Chỉ áp (Y) khi review là bullet DoD duy nhất chưa đạt. Task còn BL khác thì để In Review và liệt kê từng BL. M-CHORE-05 kiểm mọi dòng BL có nguồn là task đó. |
| F5 | should-fix | B-10 | B-10 viết "CONTRIBUTING §1 mục 4 và `team.md` nói rõ điều kiện này, kể cả cho người merge". Thực tế hai file chỉ ghi "Dev khác để lại review", không có điều kiện người review không có commit trong PR, cũng không nói về người merge. Không dòng A-xx hay B-xx nào sửa CONTRIBUTING §1.4 hay `team.md:15`. Như vậy lại có hai quy tắc, đúng vấn đề N2. | `CONTRIBUTING.md:15`; `references/team.md:15`; danh sách file của B-10 và A-02 | Thêm CONTRIBUTING §1.4 vào A-02 và `team.md:15` vào B-10, với câu: "review của một Dev không là tác giả, không có commit trong PR; người merge cũng vậy". |
| F6 | should-fix | B-02 (ngoại lệ thứ hai) | Ngoại lệ chỉ loại `test:db`, nhưng money test còn ở `npm test` (`src/common/money/*.spec.ts`, `database/transaction.service.spec.ts`) và ở `test:e2e` (`test/money.e2e-spec.ts`, `test/transaction-wiring.e2e-spec.ts`). Chính ví dụ BL-112 (`modules/identity/jwks-verifier.service.spec.ts`) cũng nằm trên đường dẫn mà B-11 cấm. | `ls backend/test/*.e2e-spec.ts`; `docs/BACKLOG.md:74` | Loại theo đường dẫn: không áp cho test nào bảo vệ code thuộc danh sách của B-11 (sau khi thêm F7). Nếu vẫn muốn cho phép BL-112 thì nêu riêng nó làm ngoại lệ có tên. |
| F7 | should-fix | B-11 (danh sách đường dẫn) | Danh sách thiếu `backend/src/database/transaction.service.ts` và `transaction.helper.ts`. Đây là `TransactionService.run` mà CONTRIBUTING §5 coi là ranh giới transaction của tiền, gồm cả retry deadlock, và được `deposit.service`, `transfer.service`, `audit.service` dùng. Thiếu luôn `common/auth/public.decorator.ts`, nơi bỏ qua guard. | CONTRIBUTING §5 dòng 2; kết quả grep `TransactionService` trong `src/` | Thêm `backend/src/database/transaction.*`, `backend/src/common/auth`. Dùng chung danh sách này cho B-02, B-08 và thứ tự BL-160. |
| F8 | should-fix | B-08 (dòng Refactor) | Characterization test là tùy chọn. Bước đỏ mặc định là "build hoặc lint fail khi còn tham chiếu", thứ chứng minh được việc xóa code nhưng không chứng minh được refactor giữ nguyên hành vi. "Theo đủ CONTRIBUTING §5" không thêm gì về test, vì §5 chỉ nói bigint, transaction, Redis. BL-157 (gộp `TransferService` và `DepositService`) vẫn qua được chỉ với build xanh. | CONTRIBUTING §5; `docs/BACKLOG.md:110` | Refactor chạm đường dẫn của B-11 phải nêu các test đang bảo vệ từng hàm bị đổi, và cho mỗi test đỏ bằng mutation trước khi refactor. Build fail chỉ dùng làm bước đỏ cho việc xóa code. |
| F9 | minor | B-13a/b | (1) Tab lưu trữ chứa cả task "đã xong **hoặc đã hủy**" (`fetch-task.mjs:86`). B-13 và TC-SKILL-02 chỉ định nghĩa trường hợp "kết quả Done", chưa nói task bị hủy tính ra sao. (2) Bước "dừng khi trùng với lần trả trước" chỉ so với payload liền trước. Nếu gviz trả về một tab board có cột `Issue Key`, một tab giả vẫn được nhận một lần với nhãn tuần sai. | `fetch-task.mjs:61,86` | Dependency bị hủy thì tính là chưa Done và nêu tên. So với mọi payload đã thấy, không chỉ payload liền trước. |
| F10 | minor | A-02 | PR template dòng 6 (`Feature doc: docs/features/DBS-`) và dòng 33 (`screenshots/DBS-<n>/`) vẫn chỉ có DBS. A-02 mới nêu dòng "Task:". | `.github/pull_request_template.md:5,6,33` | Áp câu về key ngoài board cho cả ba dòng. |

Verdict: REVISE


---

# Domain review vòng 4 (nguyên văn)

Reviewer: subagent general-purpose mới, Opus 5.5, 2026-11-07.

Tôi đã sinh lại toàn bộ 48 PR, không chỉ 6 PR mẫu: lấy file của từng PR bằng `gh pr view <n> --json files`, rồi lấy `author,mergedBy,reviews,commits`. Lọc theo danh sách đường tiền ở §2.2 ra đúng 21 PR như design ghi. Số 48/29/22 cũng đúng: 0 PR có review, người merge luôn là Lawliet119.

**Kiểm F1–F10**

| # | Trạng thái | Ghi chú |
|---|---|---|
| F1 | fixed | Máy sinh ra đúng 21 PR: #1, 2, 7, 8, 9, 12, 13, 16, 17, 29, 33, 34, 35, 44, 46, 47, 48, 54, 56, 57, 61. Riêng #1 và #2 vào nhóm này chỉ vì sửa `README.md` trong `modules/*`. Như vậy là thận trọng, không sao. |
| F2 | partially | Số 29 và 22 đúng. #1, #2 đã lên nhóm chính. Nhưng nhóm "chỉ `*.md` hoặc `.claude/`" sai theo chính quy tắc của nó (xem phát hiện mới 1). |
| F3 | fixed | G2 #4 (Y) chỉ áp cho PR merge tới `aeee9c9`. PR merge sau mốc này theo CONTRIBUTING §1.4 và B-10. |
| F4 | fixed | (Y) chỉ áp khi review là bullet DoD duy nhất chưa đạt. DBS-61 và DBS-53 được nêu theo từng mã BL. M-CHORE-05 grep mọi dòng BL theo task. |
| F5 | fixed | Đã ghi câu vào cả `team.md:15` (B-10) và CONTRIBUTING §1.4 (A-02). Nhưng chính câu đó gây ra vấn đề mới (xem phát hiện mới 2). |
| F6 | fixed | B-02 chặn theo đường dẫn, không theo lệnh chạy. Đã xác nhận BL-112 nằm ở `modules/identity/jwks-verifier.service.spec.ts`, nên bị loại đúng. |
| F7 | fixed | Đã thêm `database/transaction.*` (khớp `transaction.service.ts` và `transaction.helper.ts`) và `common/auth/` (có `public.decorator.ts`). Danh sách vẫn còn thiếu (xem phát hiện mới 3). |
| F8 | fixed | Refactor phải nêu test bảo vệ và làm đỏ bằng mutation. Build fail không dùng làm bước đỏ cho refactor. |
| F9 | fixed | B-13 so với mọi payload đã thấy. Task bị Hủy tính là chưa Done. TC-SKILL-02 có fixture Hủy. |
| F10 | fixed | A-02 phủ cả ba dòng `Task:`, `Feature doc:`, `screenshots/` của PR template. |

**Phát hiện mới**

| # | Severity | Section | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §2.1 G2 #1 (nhóm docs), M-CHORE-05 | Nhóm "chỉ đổi `*.md` hoặc `.claude/`" ghi #28, #30, khác kết quả máy. **#3** chỉ có 10 file `.md`, vậy là docs-only nhưng lại bị xếp vào nhóm "code khác". **#30** có `.agents/skills/.../scripts/fetch-task.mjs` và `check-doc-links.mjs`, không nằm dưới `.claude/` và không phải `.md`. **#28** có 0 file: head là `main`, merge commit `b478a02` chính là commit của #22, nên review nó là việc rỗng. Design nói danh sách "sinh bằng máy", nhưng M-CHORE-05 chạy lại script sẽ ra kết quả lệch. | `gh pr view 3 --json files` (10 file .md), `gh pr view 30 --json files`, `gh pr view 28 --json changedFiles,headRefName` (`0`, `main`) | Nhóm docs đổi thành #3, #28, ghi chú #28 không có diff. Chuyển #30 sang "code khác và skill". Số nhóm vẫn là 21/25/2. |
| 2 | should-fix | B-10, A-02 (§1.4, `team.md:15`), BL-160, TC-CHORE-04 | Câu "người merge cũng phải thỏa điều kiện này" có hai nghĩa. (a) Nếu là luật ai được merge thì đây là chính sách mới: người merge duy nhất (Lawliet119) không được merge PR mình có commit. Điều này chưa được đưa ra G2. Hiện CONTRIBUTING §1.4 chỉ cấm tác giả tự merge khi chưa có review. (b) Nếu là một phần của bullet "Dev khác review" thì BL-160 không bao giờ đóng được cho 22 PR cũ có người merge cũng là người viết commit. Điều kiện đóng BL-160 và TC-CHORE-04 lại chỉ xét người review ("review sau merge vẫn được tính"). Vậy là lại có hai quy tắc, đúng lỗi N2 và F5. | Câu trong B-10; G2 #1 "Điều kiện đóng BL-160"; `CONTRIBUTING.md:15`; 22 PR: #3, 12, 13, 16, 18, 19, 20, 23, 24, 33, 34, 35, 39, 41, 42, 43, 44, 51, 52, 56, 57, 61 | Viết lại: "Việc bấm merge không được tính là review. Review chỉ được tính khi người review là Dev, không phải tác giả và không có commit trong PR." Nếu muốn giới hạn cả người merge thì đưa thành câu hỏi G2 riêng, chỉ áp cho PR sau `aeee9c9`, và ghi rõ BL-160 không xét người merge. |
| 3 | should-fix | §2.2 danh sách đường tiền (dùng chung cho B-02, B-08, B-11, BL-160) | Danh sách thiếu `backend/src/common/events/`. `validateEvent` được `outbox-writer.ts`, `deposit.service.ts`, `transfer.service.ts` gọi bên trong transaction tiền, và schema có `amount: positiveMoney`. Nếu event không hợp lệ thì lệnh chuyển tiền bị hủy. Hệ quả: refactor ở đây không bắt buộc làm đỏ bằng mutation (B-08), code ở đây vẫn được retroactive (B-11), và PR #10 (tạo `common/events`) bị xếp vào nhóm không phải tiền. Nên cân nhắc thêm `backend/src/config/limits.config.ts` (hạn mức `perTx`/`perDay` kiểu bigint, BR-06, việc của BL-154). | `event-schemas.ts:77`; `git grep -l validateEvent -- backend/src/modules` | Thêm `backend/src/common/events/` (và `config/limits.config.ts`, hoặc ghi lý do không thêm). Chạy lại nhóm: #10 lên nhóm tiền, thành 22/24/2. |

Một chỗ nhỏ khác, nằm ngoài phạm vi vòng này: A-09 đổi tham chiếu trong doc DBS-76 sang BL-151. Nhưng BL-151 là một trong 21 dòng "chờ review" mà A-11 xóa, nên tham chiếu này nên trỏ tới BL-160.

Verdict: REVISE

---

# Domain review vòng 5 (nguyên văn)

Reviewer: subagent general-purpose mới, Opus 5.5, 2026-11-07.

R4-1, R4-3 and the DBS-76 note are fixed. R4-2 is only partly fixed: B-10 and BL-160 are right, but A-02 still has the old wording. The edits also added one new should-fix problem, with PR #28.

I rebuilt the input for all 48 merged PRs with read-only `gh pr view <n> --json number,files,changedFiles,headRefName` calls and ran `group-bl160.cjs` on it. The script's output matches G2 #1 exactly: money 22, other 24, docs 2. Every PR's file list matched its changed-file count, so no list was cut short.

| # | Status | Note |
|---|---|---|
| R4-1 | fixed | Script gives docs = #3 and #28 (0 files, head is `main`). #30 is in "Code khác và skill" because of its `.agents/...` and `AGENTS.md` files. #3 has only 10 `.md` files. The design text matches the script output. |
| R4-2 | partially | B-10 (line 142) and the BL-160 close condition (lines 92-96) now say: pressing merge does not count as review, and there is no limit on who may merge. But A-02 (line 57) still says "§1.4 thêm câu của B-10: người review **và người merge** không được có commit trong PR". So the same CONTRIBUTING §1.4 edit is described two ways that contradict each other. |
| R4-3 | fixed | §2.2 now has `common/events/` and `config/limits.config.ts`, and the script regex has both. #10 (which creates `common/events/*`) moved to the money group, giving 22/24/2. `limits.config.ts` exists on `main` but came from scaffold commit bd92fdc, not from a PR, so it does not change any grouping. |
| DBS-76 note | fixed | On `main`, `DBS-76-redis-adapter.md` points to BL-140 at lines 3, 118 and 128, and BACKLOG has no BL-140 row. A-09 now changes it to BL-160 and notes that BL-151 is removed in A-11. |

| # | Severity | Section | Finding | Suggested fix |
|---|---|---|---|---|
| 1 | should-fix | A-02 (line 57) compared with B-10 (line 142) | This is the part of R4-2 still open. A-02 still writes the merger rule into CONTRIBUTING §1.4, while B-10 says "Câu này không đặt thêm giới hạn nào về việc ai được bấm merge". Whoever implements A-02 from this line would put the rule into §1.4 that the review had rejected. | Change A-02 to: "§1.4 thêm đúng câu của B-10 (bấm merge không được tính là review; review chỉ tính khi người review là Dev, không phải tác giả, không có commit trong PR)". |
| 2 | should-fix | G2 #1: docs group compared with the close condition | #28 is listed in BL-160 as "không cần review". But the close condition says "Mỗi PR có một review trên GitHub". Read literally, BL-160 can only close once someone reviews a PR with no changes, which contradicts the note. | State that #28 is exempt from the close condition (or take it out of BL-160 with the reason). Make TC-CHORE-04 and M-CHORE-05 skip #28 the same way. |

Verdict: REVISE

---

# Domain review vòng 6 (nguyên văn)

Reviewer: subagent general-purpose mới, Opus 5.5, 2026-11-07.

R5-1 is fixed. R5-2 is fixed where it matters. These edits created no new blocking or should-fix contradiction; there is one minor wording point below.

| # | Status | Note |
|---|---|---|
| R5-1 | fixed | A-02 (line 57) now uses exactly B-10's sentence for CONTRIBUTING §1.4: "Bấm merge không được tính là review. Review chỉ được tính khi người review là Dev, không phải tác giả và không có commit trong PR". It then adds "Không thêm giới hạn nào về việc ai được merge". I searched every "merge" mention in the design (lines 57, 83–84, 95–96, 114, 142, 268, 276). None of them sets a rule about who may merge. Line 114 only covers when a task moves to Done (it needs a review first), which matches B-10. |
| R5-2 | fixed | Line 90 exempts #28 from the close condition and says TC-CHORE-04 and M-CHORE-05 skip it. Line 93 adds "Ngoại lệ: #28" to the close condition. TC-CHORE-04 (line 169) says "Mỗi PR trong BL-160, trừ #28". M-CHORE-05 (line 187) has no check that needs a review on each BL-160 PR, so #28 has nothing there to fail. I confirmed #28 with a read-only `gh pr view`: 0 changed files, head is `main`, and its merge commit `b478a02` is the same as #22's (DBS-31). |

**Findings:** one minor point, not blocking. Line 90 says M-CHORE-05 "bỏ qua" #28. But M-CHORE-05 also re-runs the BL-160 script and compares its output to the BACKLOG list. The script puts #28 in the docs group, so #28 must stay in that comparison. If someone read "bỏ qua" as dropping #28 from the comparison, it would fail. A safer wording would be "chỉ bỏ qua #28 khi kiểm review; #28 vẫn nằm trong danh sách so khớp".

Verdict: APPROVE
