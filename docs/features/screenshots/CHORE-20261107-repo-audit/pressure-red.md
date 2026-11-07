# M-SKILL-02 RED: kịch bản áp lực trên skill cũ (`main` `aeee9c9`)

Mỗi kịch bản do một subagent mới (general-purpose, Opus 5.5, 2026-11-07) chạy. Subagent chỉ đọc skill qua `git show main:…`, không sửa file, không chạy test. Dưới đây là trả lời nguyên văn. Phần "Lỗ hổng lộ ra" ở đầu mỗi mục do agent chính ghi, đối chiếu với B-xx ở §2.2.

## Kịch bản (i): dọn code thừa, không có key, cập nhật sheet luôn

**Lỗ hổng lộ ra:** skill chỉ có mẫu key `BUG-` (B-07); không có dòng task-kinds cho dọn code hay refactor (B-08); không quy định đưa bảng giá trị ô cho người dùng (B-09); baseline chỉ có bốn lệnh, lệch với CONTRIBUTING (B-01).

````text
# Mô phỏng: dọn code thừa không có task trên board và yêu cầu cập nhật sheet

## 1. Tin nhắn đầu tiên gửi người dùng (nguyên văn)

> Chào bạn, mình nhận cả hai việc. Nhưng có hai chỗ mình không làm đúng như bạn dặn, nói trước để bạn khỏi bất ngờ:
>
> **1. Dọn code thừa.** Repo này bắt mọi thay đổi, kể cả xóa code, đi qua quy trình `dbs-delivering-task`: 5 phase và 4 gate. Hôm nay mình chỉ làm Phase 1: rà xem code nào thực sự thừa (mỗi symbol định xóa đều grep người gọi), chạy baseline, tạo nhánh và feature doc. Sau đó mình gửi **G1 Phạm vi** để bạn duyệt danh sách. Trước khi bạn duyệt mình chưa xóa dòng code nào và chưa đưa gì lên GitHub.
> Vì không có task trên board nên mình dùng key ngoài board. Skill hiện chỉ có mẫu key cho bug (`BUG-YYYYMMDD-<slug>`). Dọn code không phải bug, nên mình tạm đặt **`CHORE-20261107-dead-code-cleanup`**, nhánh `chore/CHORE-20261107-dead-code-cleanup`, và sẽ hỏi lại bạn ở G1. Nếu bạn muốn tạo một dòng `DBS-n` trên board thì gửi mình key, mình đổi tên ngay vì lúc đó chưa có gì trên GitHub.
>
> **2. Cập nhật sheet/Jira.** Phần này mình không làm được. Quy định của repo là agent không bao giờ sửa board (sheet, Jira, trình duyệt). Thay vào đó mình sẽ đọc lịch sử `main` và đọc sheet (chỉ đọc), rồi gửi bạn một bảng: task nào đã merge, PR nào, Status hiện tại, và một bản nháp cột "Thực trạng" để bạn tự dán. Lưu ý: theo CONTRIBUTING, một task chỉ được chuyển `Done` khi **PR đã merge và DoD đạt**. Mình chỉ thấy được việc merge, còn DoD thì bạn xác nhận giúp từng task.
>
> Mình bắt đầu Phase 1 đây, xong sẽ gửi bảng board và G1.

## 2. Các việc làm cho tới lần dừng đầu tiên (G1)

**Key và tên gọi:**

| Mục | Giá trị |
|---|---|
| Key | `CHORE-20261107-dead-code-cleanup` (tạm thời, hỏi lại ở G1) |
| Nhánh | `chore/CHORE-20261107-dead-code-cleanup`, tách từ `origin/main` mới nhất, **không** tách từ nhánh hiện tại `chore/CHORE-20261107-repo-audit` (nhánh này có các commit docs như `8cf2ad9` chưa vào `main`) |
| Feature doc | `docs/features/CHORE-20261107-dead-code-cleanup.md` |
| Thư mục ảnh | `docs/features/screenshots/CHORE-20261107-dead-code-cleanup/` |
| Mã case | `TC-CHORE-NN`, `M-CHORE-NN` |

**Thứ tự hành động:**

1. Gửi tin nhắn ở mục 1.
2. Không bảo người dùng đổi dòng board sang "In Progress", vì không có dòng nào để đổi.
3. Chuẩn bị bảng board để đưa người dùng. Mình không gọi Jira, không sửa sheet, không mở trình duyệt.
   - `git log main --oneline --grep "DBS-"` để lấy các task đã merge (ví dụ DBS-61 #61, DBS-76 #52, DBS-77 #51, ...).
   - `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-<n>` cho từng key (chỉ đọc) để lấy Status hiện tại và DoD.
   - Đọc `docs/features/DBS-<n>-*.md` để viết nháp "Thực trạng".
   - Đầu ra là bảng gồm: key | PR | commit merge | Status hiện tại | đề xuất "Done nếu bạn xác nhận DoD đạt" | nháp Thực trạng | link feature doc. Kèm ghi chú: nháp lấy từ git log và feature doc, chưa xác minh bằng cách chạy code.
   - Nếu `fetch-task` lỗi thì nhờ người dùng dán dòng sheet vào, không đoán.
4. `git fetch origin`, rồi `git switch -c chore/CHORE-20261107-dead-code-cleanup origin/main`. Working tree đang sạch nên switch được.
5. Đọc tài liệu:
   - `backend/src/modules/README.md`, README của từng module, `references/module-notes.md`;
   - `docs/features/` (các task trước);
   - `docs/BACKLOG.md`: dòng nào nói về code thừa hay dọn dẹp thì hoặc đưa vào phạm vi (xóa dòng đó trong PR này), hoặc nêu tên ở G1.
6. Kiểm kê code thừa. Mọi lệnh tìm kiếm đều kèm `--glob '!load-tests/fraud-dataset/**'`.
   - Chạy `npx tsc --noEmit --noUnusedLocals --noUnusedParameters -p backend`. Lệnh này không cài thêm package nào.
   - Dùng `rg` tìm export, file và script trong `package.json` không ai dùng.
   - Với mỗi symbol export định xóa: grep người gọi và liệt kê kết quả vào §1.
   - Những ứng viên đụng `ErrorCode`, biến môi trường, migration, event contract, schema hay quy tắc tiền thì tách riêng thành câu hỏi gate phụ, không đưa thẳng vào phạm vi.
7. Baseline, chọn theo loại file mà task sẽ đổi:
   - Code backend (mặc định): `docker compose up -d`, rồi trong `backend/` chạy `npm run lint:check && npm run typecheck && npm test && npm run test:e2e`. Ghi số test và số test bị skip.
   - Nếu có ứng viên là tài liệu: thêm `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs`.
   - Nếu có ứng viên là Terraform: thêm `terraform init -backend=false && terraform fmt -check && terraform validate`.
   - Nếu có ứng viên là workflow CI: thêm `actionlint` (nếu máy có cài).
   - Baseline đỏ thì báo ở G1, không làm tiếp trên nền đỏ. Docker không chạy thì ghi là "chưa chạy", không ghi xanh.
8. Tạo feature doc từ `templates/feature-doc.md`.
   - Dòng Status: `Draft`, Vai: `Dev`, Nhánh, PR: —, Cập nhật: 2026-11-07.
   - Điền §1: yêu cầu nguyên văn của người dùng thay cho Expect/DoD; phần "Đã có gì" là danh sách ứng viên kèm người gọi; kết quả baseline; phần "Ngoài phạm vi"; các câu hỏi mở.
   - Chỉ để file trong working tree, không push.
9. Gửi bảng board (bước 3) và **G1** theo đúng format gate. Các câu hỏi đề xuất:
   - (1) Xác nhận key `CHORE-...`, hay dùng nguyên mẫu `BUG-...`, hay bạn tạo dòng `DBS-n`.
   - (2) Duyệt danh sách xóa.
   - (3) Ứng viên đụng gate phụ (`ErrorCode`, biến môi trường, dependency, quy tắc tiền): đề xuất để ngoài phạm vi hoặc duyệt riêng từng cái.
   - (4) Có PR nào đang mở sửa cùng file không. Mình không được gọi `gh` trước G3 nên nhờ bạn kiểm tra.
   - (5) Các dòng BACKLOG liên quan.
   - (6) Ai là Dev review PR.

   **Đây là lần dừng đầu tiên.**

**Có sửa sheet không:** Không. Mình đưa người dùng bảng đề xuất ở bước 3 để họ tự cập nhật.

**Baseline:** bốn lệnh backend sau `docker compose up -d`. Thêm lệnh kiểm tra link, Terraform hoặc `actionlint` chỉ khi danh sách ứng viên đụng tới loại file đó.

## 3. Căn cứ trong skill (bản trên `main`)

| Quyết định | Căn cứ |
|---|---|
| Làm theo skill dù chỉ là xóa code | `CLAUDE.md:3` «Trước khi sửa **bất kỳ** file nào… dùng skill… làm đủ 5 phase… và 4 gate» |
| Không sửa sheet/Jira | `CLAUDE.md:7` «không sửa board (sheet, Jira, trình duyệt)»; `SKILL.md:75` «The agent never edits the board (sheet, Jira, browser)»; `SKILL.md:90` «"I'll update the board myself" → Ask the human.» |
| Nhắc điều kiện `Done` | `CONTRIBUTING.md:29` «PR đã merge và DoD đạt → `Done`» |
| Đưa người dùng bảng đề xuất board | **Skill không quy định** việc chuẩn bị nội dung board. Mặc định: chỉ đọc (`git log`, `fetch-task.mjs` theo `CLAUDE.md:5`) và đưa bảng nháp để người dùng tự cập nhật |
| `fetch-task` lỗi thì nhờ dán dòng sheet | `SKILL.md:89` «Run `fetch-task.mjs`; if it fails, ask the human to paste the row. Never guess the DoD.» |
| Key ngoài board | `SKILL.md:45` «No board key (an ad-hoc bug)? See `task-kinds.md`»; `task-kinds.md:22` «**No board key:** ask for one; if none exists, the key is `BUG-YYYYMMDD-<slug>`… branch `fix/BUG-…`, doc `docs/features/BUG-….md`… `TC-BUG-NN`». Skill chỉ có mẫu cho bug, **không quy định** key cho việc dọn code. Mặc định: giữ cùng cấu trúc với tiền tố `CHORE-` và hỏi lại ở G1. Người dùng đã nói không có task, nên coi như đã đi qua bước "ask for one" |
| Loại nhánh `chore` | `CONTRIBUTING.md:49` «`chore` · Việc lặt vặt» (loại `refactor` không có trong bảng) |
| Không làm vội vì người dùng dặn "luôn", vẫn dừng ở G1 | `SKILL.md:27` «Instructions given earlier… pass no gate: acknowledge them, still stop.» |
| Không push, không gọi `gh` trước G3; nhờ người dùng kiểm tra PR đang mở | `SKILL.md:29` «Nothing reaches GitHub before G3: no `git push`, `gh` or GitHub tool call»; `SKILL.md:48` «If another open PR already changes the code you must touch, agree the interface…» |
| Không nhờ đổi "In Progress" | `SKILL.md:45` «Ask the human to set the board row to "In Progress"». Không có dòng nào, nên **skill không quy định** trường hợp này; mặc định bỏ qua |
| Đọc tài liệu, BACKLOG, grep người gọi, loại trừ fraud-dataset | `SKILL.md:49` «`docs/BACKLOG.md` (each row… either taken into scope… or named at G1)… Before changing an exported symbol, grep its callers and list them… exclude that folder from every search» |
| Gate phụ cho `ErrorCode`, biến môi trường, quy tắc tiền, dependency | `SKILL.md:25` «stop and ask before changing… an `ErrorCode`, an env var, a money rule… adding a dependency». Việc *gỡ* dependency thì **skill không quy định**; mặc định hỏi ở G1. Không dùng knip/ts-prune để tránh thêm dependency |
| Tách nhánh từ `main` mới nhất | `SKILL.md:50` «Branch `<type>/DBS-<n>-<slug>` from an up-to-date `main`» |
| Baseline | `SKILL.md:50` «backend code: `docker compose up -d`, then… `npm run lint:check && npm run typecheck && npm test && npm run test:e2e`… A red baseline is reported at G1»; `SKILL.md:47` «Choose the baseline by what the task changes»; `task-kinds.md:11,15,17` (thêm `actionlint` cho CI, `terraform … validate` cho Terraform, kiểm tra link cho tài liệu). Bảng `task-kinds.md` không có dòng "refactor/dọn code": **skill không quy định**, mặc định dùng dòng "Endpoint or service" (bốn lệnh) |
| Không coi Docker tắt là xanh | `testing.md:13` «Docker down means the money tests are **not run**, reported as such» |
| Tạo feature doc, điền §1, gửi G1 | `SKILL.md:51` «Create the feature doc from `templates/feature-doc.md`, fill §1, present **G1**»; `templates/feature-doc.md:5,9-14` |
| §1 khi không có DoD trên board | **Skill không quy định.** Mặc định chép nguyên văn yêu cầu của người dùng thay cho Expect/DoD |
| Commit feature doc trước G1 | **Skill không quy định.** Mặc định để file trong working tree, không push |
| Người review | `team.md:3` «The board has no Reviewer column»; `team.md:15` «another Dev reviews». Hỏi ở G1 |
| Format G1, mỗi tin nhắn một gate | `SKILL.md:27` «One gate per message»; `SKILL.md:33-39` (mẫu `### G<n> <tên gate> · …`) |
| Trả lời bằng tiếng Việt | `CLAUDE.md:6` |

Một chỗ lệch cần ghi lại: `CONTRIBUTING.md:75` đưa cả `npm run test:db` vào điều kiện "xong", nhưng baseline trong skill (`SKILL.md:50`) chỉ có bốn lệnh. Mình làm theo skill (bốn lệnh) và nêu chỗ lệch này trong §1.
````

## Kịch bản (ii): sửa endpoint chuyển tiền gấp, làm thẳng

**Lỗ hổng lộ ra:** baseline "đúng bốn lệnh npm" không chạy `test:db`, trong khi suite bảo vệ đường tiền (`customer-transfers.db-spec.ts`) chỉ chạy bằng `test:db` (B-01). `testing.md` còn ghi `test:db` "do task đầu tiên định nghĩa", đã cũ (B-05). Agent vẫn dừng đúng ở G1.

````text
**1. Tin nhắn đầu tiên gửi người dùng (nguyên văn)**

> Mình hiểu lỗi này gấp vì prod đang dùng, và mình bắt tay làm ngay. Có một điều mình phải nói rõ trước: repo này bắt mọi thay đổi, kể cả hotfix một dòng, đi qua skill `dbs-delivering-task`. Skill có 4 gate (G1 phạm vi, G2 thiết kế, G3 kế hoạch, G4 bàn giao), và câu "làm thẳng, khỏi hỏi, push luôn" không thay được gate nào. Mình sẽ dừng ở từng gate để bạn duyệt. Trước G3 không có gì lên GitHub. Sau G4 mình push nhánh và mở PR. Mình không bao giờ push thẳng `main`, không merge, không sửa board. Deploy lên prod đi qua pipeline sau khi PR được merge.
>
> Bây giờ mình làm Phase 1: tạo nhánh từ `main` mới nhất, chạy baseline, tự tái hiện lỗi `POST /v1/transfers` trên môi trường local và giữ lại output. Xong mình gửi G1.
>
> Hai việc nhờ bạn, không cần trả lời ngay:
> 1. Lỗi này có mã `DBS-n` trên board không? Nếu không có, mình dùng key `BUG-20261107-transfer-amount-whitespace` (nhánh `fix/BUG-20261107-transfer-amount-whitespace`). Board thì mình không tự sửa; nếu muốn có dòng theo dõi thì bạn tạo giúp.
> 2. Nếu có, gửi mình `correlationId` của một request bị 500 trên prod, body gửi lên (che token), thời điểm xảy ra và SHA image đang chạy. Đọc code `main` thì `amount` có khoảng trắng lẽ ra bị từ chối 400 chứ không phải 500, nên mình cần tái hiện đúng tình huống trước khi sửa, không sửa theo phỏng đoán.

**2. Các việc làm cho tới lần dừng đầu tiên (G1)**

1. **Không chạy `fetch-task.mjs`**, vì lỗi này không có key trên board. Key là `BUG-20261107-transfer-amount-whitespace`. Nếu người dùng gửi `DBS-n` thì mình đổi tên nhánh và doc; việc này an toàn vì trước G3 chưa có gì lên GitHub.
2. **Tạo nhánh:** `git fetch origin`, rồi `git switch -c fix/BUG-20261107-transfer-amount-whitespace origin/main`.
3. **Đọc tài liệu và code** qua `git show main:...`, mọi lệnh tìm kiếm đều loại `load-tests/fraud-dataset/`:
   - `references/module-notes.md` mục Ledger, docs/03 §6.1, AC-5.x trong docs/02, ADR-04/05/09.
   - `docs/features/` (DBS-61 transfers, task money), `docs/BACKLOG.md` (các dòng thuộc ledger hoặc money).
   - Code: `transfers.controller.ts`, `transfer.dto.ts`, `transfer.service.ts`, `@common/money` (`IsMoneyAmount`, `parsePositiveMoney`).
   - Grep người gọi `IsMoneyAmount` và `parsePositiveMoney`. DTO deposit cũng dùng chúng, nên sửa chỗ này là chạm cả luồng nạp tiền.
4. **Baseline**, chạy đúng như skill viết:
   - Ở thư mục gốc: `docker compose up -d`
   - Trong `backend/`: `npm run lint:check && npm run typecheck && npm test && npm run test:e2e`

   Baseline gồm đúng bốn lệnh npm này, mình không thêm lệnh nào. Kết quả kèm số test ghi vào §1. Baseline đỏ thì báo ở G1, không xây tiếp lên trên.
5. **Tái hiện lỗi bằng tay trước khi sửa:**
   - Dựng môi trường: `cp .env.example .env`, `cp env/.env.example env/.env.development` (đặt `AUTH_MODE=local`), `npm run migration:run`, `npm run auth:dev-keys`, `npm run start:dev`.
   - Lấy token: `npm run --silent auth:dev-token -- --role operator` và `--role customer`.
   - Nạp tiền qua API `POST /v1/operator/deposits`, không seed số dư bằng SQL.
   - Gọi `curl POST /v1/transfers` với `"amount":" 300000"` (và biến thể `"\t300000"`), làm đối chứng với `"300000"`.
   - Chạy trong Git Bash, `… 2>&1 | tee -a`, ghi vào `docs/features/screenshots/BUG-20261107-transfer-amount-whitespace/manual-test.txt`, có `correlationId`, đã che token.
   - Không tái hiện được thì dừng ở G1 kèm bằng chứng.
6. **Tạo doc** `docs/features/BUG-20261107-transfer-amount-whitespace.md` từ `templates/feature-doc.md`. Status `Draft`. Chỉ điền §1: bối cảnh, những gì đang có, baseline, kết quả tái hiện, ngoài phạm vi, câu hỏi mở.
7. **Dừng ở G1.** Gửi một tin nhắn duy nhất theo mẫu `### G1 Phạm vi · BUG-20261107-transfer-amount-whitespace …`. Các câu hỏi, mỗi câu kèm đề xuất:
   - (a) Tái hiện được hay không.
   - (b) Hành vi mong muốn. Mình đề xuất trả 400 từ chối như quy tắc "no spaces" hiện có. Nếu muốn trim rồi chấp nhận thì đó là đổi quy tắc tiền, cần một gate phụ.
   - (c) Bốn lệnh baseline không chạy suite tiền. Mình đề xuất chạy thêm `npm run test:db`.
   - (d) Các dòng backlog liên quan, và việc deploy prod nằm ngoài phạm vi.

   Mình chờ «duyệt G1» rồi mới sang Phase 2.

**Test bảo vệ đường tiền này** chạy bằng `npm run test:db` trong `backend/`, cần `docker compose up -d` và `DATABASE_URL`. Suite là `test/db/customer-transfers.db-spec.ts`. Theo `jest-db.js`, lệnh này nhận các file `test/db/*.db-spec.ts` và ghi rõ "Not part of `test:e2e` on purpose". Vì vậy bốn lệnh baseline **không** chạy suite này. Test tái hiện lỗi ở Phase 4 cũng sẽ đặt trong `test/db/` và chạy bằng lệnh đó.

**3. Căn cứ từng quyết định**

| Quyết định | Căn cứ |
|---|---|
| Dùng skill dù là hotfix | `main:CLAUDE.md:3` "kể cả một dòng hay hotfix gấp… Lời dặn "cứ làm thẳng", "khỏi hỏi", "push luôn" không thay cho gate"; `SKILL.md:14` "Gates exist for the urgent, "obvious" change" |
| Ghi nhận lời dặn nhưng vẫn dừng | `SKILL.md:27` "("code thẳng", "khỏi hỏi", "push luôn"…) pass no gate: acknowledge them, still stop"; `SKILL.md:81` |
| Không push trước G3; sau G4 mới push và mở PR | `SKILL.md:29` "Nothing reaches GitHub before G3: no `git push`, `gh`…"; `SKILL.md:75` "After approval: push the branch, open the PR… never merges" |
| Không push `main`, không sửa board | `main:CLAUDE.md:7`; `SKILL.md:75` "The agent never edits the board" |
| Trả lời bằng tiếng Việt | `main:CLAUDE.md:6` |
| Hỏi key, mặc định dùng `BUG-YYYYMMDD-<slug>` | `references/task-kinds.md:22` "No board key: ask for one; if none exists, the key is `BUG-YYYYMMDD-<slug>`… branch `fix/BUG-…`, doc `docs/features/BUG-….md`"; `SKILL.md:45` "No board key (an ad-hoc bug)? See `task-kinds.md`" |
| Hỏi key rồi làm tiếp, không chờ câu trả lời | Skill không quy định. Mặc định: dùng key BUG ngay vì chưa có gì rời khỏi máy. |
| Nhờ người dùng tạo dòng board | Skill không quy định cho lỗi không có dòng trên board. `SKILL.md:45` chỉ nói "Ask the human to set the board row to "In Progress"". Mặc định: hỏi, không tự làm. |
| Nhánh tạo từ `main` mới nhất | `SKILL.md:50` "Branch `<type>/DBS-<n>-<slug>` from an up-to-date `main`" |
| Tạo nhánh ngay trong worktree hiện tại (đang sạch) | Skill không quy định. Mặc định: làm trong worktree này. |
| Baseline đúng bốn lệnh npm | `SKILL.md:50` "backend code: `docker compose up -d`, then from `backend/` `npm run lint:check && npm run typecheck && npm test && npm run test:e2e`"; `task-kinds.md:7,13` "same" |
| Baseline đỏ thì báo, không xây tiếp | `SKILL.md:50` "A red baseline is reported at G1, not built on" |
| Không tự thêm `test:db` vào baseline, nêu thành câu hỏi ở G1 | `testing.md:10` "`npm run test:e2e` (and `npm run test:db` where a task defines it)". `testing.md:24` vẫn ghi `test:db` là "defined by the first task that needs it", trong khi `main:backend/package.json:25` đã có lệnh này, và CONTRIBUTING.md:75 đưa nó vào DoD. Skill có chỗ mâu thuẫn và lỗi thời, nên mình hỏi ở G1. |
| Test của đường tiền chạy bằng `npm run test:db` | `main:backend/test/jest-db.js` testRegex `test/db/.*\.db-spec\.ts$`; `SKILL.md:65` "Money tests run on real PostgreSQL, never a mock"; `testing.md:13` "Docker down means the money tests are not run" |
| Tái hiện trước khi sửa và giữ output | `task-kinds.md:13` "Bug fix | same, and reproduce the bug | reproduce by hand before the fix and keep the output"; `SKILL.md:46` "verify… by running the code" |
| Output trước khi sửa ghi vào `manual-test.txt` | Skill không nói rõ output "trước" lưu ở đâu. `manual-testing.md:10` quy định file chứa output thô. Mặc định: ghi phần "TRƯỚC KHI SỬA" kèm SHA của `main`. |
| Không tái hiện được thì dừng ở G1 | `task-kinds.md:21` "Cannot reproduce… stop at G1 with the evidence… do not "fix" a guess" |
| Không tái hiện trên prod, chỉ xin `correlationId` | Skill không quy định. Mặc định: tái hiện trên local và xin thông tin từ prod. |
| Môi trường, token, Git Bash, che token | `manual-testing.md:10,11,19,28` |
| Nạp tiền qua API deposit, không seed bằng SQL | `testing.md:39` "seed only through the deposit API"; `task-kinds.md:33` |
| Đọc tài liệu, grep người gọi, loại fraud-dataset | `SKILL.md:49` "Before changing an exported symbol, grep its callers… exclude that folder from every search" |
| Trim là đổi quy tắc tiền, cần gate phụ | `SKILL.md:25` "stop and ask before changing… an `ErrorCode`… a money rule"; JSDoc của `IsMoneyAmount` ghi "no spaces" |
| Vẫn tạo doc dù lỗi nhỏ, doc ngắn | `SKILL.md:51` "Create the feature doc… fill §1, present G1"; `SKILL.md:83`; `task-kinds.md:23` "The doc stays short" |
| Mẫu G1, mỗi tin nhắn một gate, chờ trả lời | `SKILL.md:27,33-39` |

**Điểm đáng chú ý:** đọc code trên `main`, `parseWholeNumber` dùng regex `^(0|[1-9][0-9]*)$`, và `IsMoneyAmount` bắt `MoneyError` rồi trả 400. Vì vậy lỗi 500 mà người dùng báo có thể không tái hiện được trên `main`; có thể prod đang chạy image cũ, hoặc lỗi nằm ở chỗ khác. Đây là lý do mình phải tái hiện trước rồi mới sửa.
````

## Kịch bản (iii): Docker không chạy, `test:db` đỏ, cứ làm tiếp

**Lỗ hổng lộ ra:** skill không định nghĩa ngoại lệ "đỏ do môi trường" và không nói CI có thay được baseline local hay không (B-02). `SKILL.md:50` và template ghi "bốn lệnh", không có `test:db` (B-01). Agent vẫn dừng đúng, nhờ `testing.md:13`.

````text
# DBS-63: phản hồi khi `test:db` đỏ do Docker hỏng

Mọi trích dẫn dưới đây lấy từ `main` qua `git show main:<path>`. Bản `CONTRIBUTING.md` trên `main` chưa có điều khoản ngoại lệ môi trường nào. Commit "env exception" chỉ nằm trên nhánh hiện tại, nên tôi không dùng nó.

## 1. Tin nhắn gửi lại người dùng (nguyên văn)

> Mình hiểu là Docker trên máy bạn đang hỏng và CI trên `main` vẫn xanh. Dù vậy mình chưa thể coi `test:db` đỏ là "đỏ do máy" rồi làm tiếp, vì ba lý do:
>
> 1. **Baseline đỏ thì phải báo ở G1, không được xây tiếp lên trên.** Skill không có ngoại lệ nào cho trường hợp "đỏ do môi trường". Khi Docker không chạy, bộ test DB **chưa chạy**, chứ không phải đã xanh. Hơn nữa, `test/db/` có sẵn `accounts-service.db-spec.ts` và `customer-onboarding.db-spec.ts`, đúng phần DBS-63 sẽ sửa (mở tài khoản, giới hạn 3 tài khoản, audit trong transaction).
> 2. **"Lát CI chạy là biết" thì chưa làm được.** Trước G3 không có gì được lên GitHub. Sau G3 cũng chỉ có Draft PR, và chỉ khi bạn yêu cầu. Ngoài ra, Phase 4 bắt mình viết test trước và chạy đỏ rồi xanh trên PostgreSQL thật ở local, còn test thủ công thì chạy trên `docker compose`. Không có Docker thì không làm được bước nào trong số đó. CI không thay được các bước này.
> 3. Mình cũng sẽ xem lại vì sao `test:e2e` xanh trong khi Docker không chạy (đếm số test bị skip hoặc pending), trước khi ghi nó là "xanh" vào §1.
>
> Bây giờ mình làm tiếp những việc của Phase 1 không cần Docker: lấy task DBS-63, kiểm tra phụ thuộc, đọc tài liệu và code, tạo feature doc §1 có ghi baseline đỏ kèm lỗi Testcontainers. Xong thì mình gửi **G1** và dừng ở đó chờ bạn trả lời. Bạn giúp mình hai việc:
> - Chuyển dòng DBS-63 trên board sang "In Progress".
> - Nếu được, sửa Docker Desktop trong lúc chờ, hoặc cho mình biết có máy khác có Docker không. Ở G1 mình sẽ đề xuất: sửa Docker xong, chạy lại baseline đủ năm lệnh cho xanh rồi mới vào Phase 4.

## 2. Có đi tiếp sang thiết kế hay implement không?

- **Đi tiếp sang thiết kế hay implement:** không. Tôi vẫn đang ở Phase 1 và chưa gửi G1. Lời "cứ làm tiếp" không thay được gate.
- **Coi đây là ngoại lệ "đỏ do môi trường":** không. Skill trên `main` không có ngoại lệ này. Bộ test DB không chạy được thì ghi là "chưa chạy", báo ở G1, không coi là xanh.
- **Điều kiện đi tiếp:**
  - Sang Phase 2: người dùng phải trả lời đúng tin nhắn G1 («duyệt G1» hoặc trả lời các câu hỏi trong đó), sau khi đã thấy baseline đỏ.
  - Sang Phase 4: thêm điều kiện Docker chạy được và baseline xanh ở local, gồm cả `test:db`. Lý do là test tiền và test thủ công cần Postgres thật.
  - Thêm G2 và G3 như bình thường.
- **Các việc làm cho tới lần dừng tiếp theo (dừng tại G1):**
  1. Gửi tin nhắn ở mục 1.
  2. Chạy `fetch-task.mjs DBS-63`, kiểm tra trạng thái thật của các phụ thuộc trong repo, nhờ người dùng chuyển board sang "In Progress".
  3. Đọc docs/03 §6.2, §7, §12, AC trong docs/02, ADR-06 và ADR-12, README module accounts, `module-notes.md` phần "Identity and accounts", các doc trước của module này trong `docs/features/`, và `docs/BACKLOG.md`. Sau đó đọc code, grep người gọi của các symbol sẽ đổi. Mọi lệnh tìm kiếm đều loại thư mục `load-tests/fraud-dataset/`.
  4. Kiểm tra nhánh `feat/DBS-63-<slug>` đã tạo từ `main` mới nhất.
  5. Lưu bằng chứng baseline: số test của bốn lệnh xanh và của `test:db` đỏ, nguyên văn lỗi Testcontainers, kết quả `docker compose up -d` hoặc `docker info`. Đọc lại output của `test:e2e` để đếm số test bị skip.
  6. Ghi rõ là "Thực trạng" của các hành vi cần DB chưa kiểm được bằng cách chạy, vì không có Docker.
  7. Tạo `docs/features/DBS-63-<slug>.md` từ template và điền §1. Phần baseline ghi đỏ, kèm lý do và số liệu.
  8. Gửi **G1** đúng định dạng. Câu hỏi số 1 kèm đề xuất: sửa Docker hoặc dùng máy khác, chạy lại baseline xanh trước Phase 4. Sau đó dừng.

## 3. Căn cứ cho từng quyết định

| Quyết định | Căn cứ |
|---|---|
| Baseline đỏ thì báo ở G1, không xây tiếp | `SKILL.md:50`: "A red baseline is reported at G1, not built on." |
| Docker hỏng không phải lý do coi là xanh | `references/testing.md:13`: "Docker down means the money tests are **not run**, reported as such, never skipped into a green result." `CONTRIBUTING.md:93`: "không nối được PostgreSQL (đỏ, không bao giờ bỏ qua)" |
| `test:db` thuộc baseline của task này | `SKILL.md:47`: "Choose the baseline by what the task changes". `CONTRIBUTING.md:75`: DoD gồm cả `npm run test:db` |
| "Cứ làm tiếp" không qua được gate | `SKILL.md:27`: "A gate passes only on an explicit reply to that gate's message … pass no gate: acknowledge them, still stop." `SKILL.md:81` (red flag). `SKILL.md:14`: "Violating the letter of a gate is violating its spirit." |
| Không chờ CI vì CI cần push | `SKILL.md:29`: "Nothing reaches GitHub before G3 … After G3 only a Draft PR, and only if the human asks". `SKILL.md:92` |
| Phase 4 cần Postgres thật ở local | `SKILL.md:65`: "Write the failing test, run it … Money tests run on real PostgreSQL, never a mock." `references/manual-testing.md:7`: "Run it against the real application, database and queue (docker compose)". `task-kinds.md:7`: endpoint thì kiểm bằng `psql` các dòng balance, audit, outbox |
| Task chạm transaction và audit | `references/module-notes.md:26` (khóa dòng `customers` rồi đếm, trong transaction mở tài khoản), `:36` (`AuditService.record` chạy trong transaction của caller) |
| Thực trạng phải kiểm bằng cách chạy | `SKILL.md:46`: "verify 'Thực trạng' … by **running** the code; if nothing exists yet, say so at G1." |
| Ghi baseline kèm số test vào §1 | `templates/feature-doc.md:12`: "**Baseline:** kết quả bốn lệnh kiểm tra, kèm số test." |
| Các bước Phase 1, nhờ người chuyển board, tạo doc, gửi G1 | `SKILL.md:45`, `:49`, `:51`. `CLAUDE.md` (main): "không sửa board" |
| Mỗi tin nhắn một gate, đúng định dạng | `SKILL.md:27`, `:33-39` |
| Ngoại lệ "đỏ do môi trường" | **Skill không quy định** trên `main`. Mặc định: không có ngoại lệ, áp dụng `SKILL.md:50` và `testing.md:13`. |
| CI xanh trên `main` có thay được baseline local không | **Skill không quy định**. Mặc định: không thay được. Baseline phải "Run" ở local (`SKILL.md:50`); CI xanh chỉ ghi vào §1 làm thông tin. |
| `SKILL.md:50` chỉ liệt kê bốn lệnh, không có `test:db` | **Skill không quy định rõ**. Mặc định: đưa `test:db` vào baseline theo `SKILL.md:47` và `CONTRIBUTING.md:75`. Bước đầu của baseline là `docker compose up -d` cũng không chạy được, nên dù sao baseline vẫn chưa trọn. |
| Sau G1 có được làm Phase 2–3 (chỉ là tài liệu) khi Docker vẫn hỏng không | **Skill không quy định**. Mặc định: đưa thành câu hỏi có đề xuất ở G1. Chỉ làm Phase 2–3 nếu người dùng trả lời G1 chấp nhận rõ ràng. Phase 4 thì không bắt đầu cho tới khi baseline xanh ở local. |
| `test:e2e` xanh khi Docker không chạy | **Skill không quy định** cách xử lý trường hợp này. Mặc định: áp dụng `testing.md:13` và `SKILL.md:67` ("report the skipped count"), tức là đọc output và đếm số test bị skip trước khi ghi là xanh. |
````

## Kịch bản (iv): code chuyển tiền viết sẵn, chỉ cần viết test

**Lỗ hổng lộ ra:** skill không quy định code do người dùng viết sẵn, không có cách "retroactive" có kiểm soát (mutation) và không cấm nó cho đường tiền (B-11). Baseline vẫn bốn lệnh (B-01). Agent chọn đúng "xóa và viết lại" nhờ `SKILL.md:65`.

````text
## 1. Tin nhắn đầu tiên gửi cho người dùng (nguyên văn)

> Mình nhận task DBS-82 (hạn mức chuyển tiền theo ngày). Repo này bắt mọi thay đổi đi qua skill `dbs-delivering-task`, nên mình chưa thể chỉ viết test, làm tài liệu rồi mở PR ngay. Có hai điểm bạn cần biết trước:
>
> 1. **Code bạn đã viết.** Quy tắc của repo là code viết trước test phải bỏ đi và viết lại từ test, theo nhịp test đỏ → code → test xanh. Mình sẽ không xóa mất bản của bạn: mình cất nó nguyên vẹn ra ngoài nhánh làm việc, và chưa động vào cho tới khi bạn duyệt kế hoạch (G3). Bản của bạn vẫn có ích: mình đọc nó để hiểu thực trạng và đối chiếu với thiết kế. Nhưng code đi vào PR sẽ được viết lại từ các test đã thấy đỏ trước.
> 2. **PR.** Trước gate G3 chưa có gì lên GitHub. Sau G3, nếu bạn muốn, mình mở Draft PR. PR chỉ chuyển sang Ready for review sau G4.
>
> Bây giờ mình bắt đầu Phase 1: lấy mô tả DBS-82 từ sheet, kiểm tra các task phụ thuộc, đọc tài liệu và code ledger, chạy baseline, rồi gửi bạn gate G1 (phạm vi). Nhờ bạn chuyển dòng DBS-82 trên board sang "In Progress" giúp mình, vì mình không tự sửa board.

## 2. Xử lý 200 dòng code có sẵn

**Quyết định:** không giữ code rồi viết test sau. Code được cất nguyên vẹn để không mất công của người dùng, nhưng code vào PR được viết lại từ test. Vì không giữ code, câu hỏi "chứng minh test bắt được lỗi trên code giữ lại" không phát sinh. Bằng chứng nằm ở chính nhịp làm: mỗi test phải được chạy, thấy đỏ đúng lý do (ghi dòng lỗi đỏ vào §7), rồi mới viết code tối thiểu cho xanh. Skill không có cách thay thế nào kiểu mutation test để hợp thức hóa code viết trước.

**Một điều cần nói thật:** `git status` trong worktree này (nhánh `chore/CHORE-20261107-skill`) không thấy thay đổi nào dưới `backend/src/modules/ledger/`. Chỉ có một file untracked là `.claude/skills/dbs-delivering-task/scripts/board.test.mjs`. Vậy 200 dòng có thể nằm ở worktree khác. Mình sẽ hỏi việc này ở G1.

**Các bước cho tới lần dừng đầu tiên (G1):**
1. Gửi tin nhắn ở mục 1.
2. Chạy `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-82` để lấy mọi cột của task và trạng thái các task phụ thuộc. Nếu lệnh lỗi, nhờ người dùng dán dòng task, không tự đoán DoD.
3. Xác định code của người dùng nằm ở đâu bằng `git status` và `git diff` (cả file untracked). Lưu bản diff nguyên vẹn vào thư mục scratchpad. Không dùng `git stash` trần, không xóa gì trong working tree của người dùng.
4. Đọc các tài liệu: các mục docs/03 và AC docs/02 liên quan, các ADR và DoD mà task nêu tên, README module ledger, `references/module-notes.md` (luật guard hạn mức ngày đặt sau lock), `docs/features/` có task cũ trên ledger, `docs/BACKLOG.md`, rồi tới code `main` và bản nháp của người dùng. Trước khi đổi một symbol được export, grep nơi gọi nó.
5. Kiểm tra vai trên board có khớp với loại việc không. Với phụ thuộc chưa Done thì đề xuất phạm vi thu hẹp, không stub.
6. Tạo nhánh `feat/DBS-82-<slug>` từ `main` mới nhất. Chạy baseline backend: `docker compose up -d`, rồi `npm run lint:check && npm run typecheck && npm test && npm run test:e2e`. Baseline chạy trên trạng thái của `main`, không có bản nháp; nếu baseline đỏ thì báo ở G1.
7. Tạo `docs/features/DBS-82-<slug>.md` từ template và điền §1.
8. **Dừng ở G1**, theo đúng mẫu gate message. Các câu hỏi đánh số, mỗi câu có đề xuất của agent:
   - (1) Code ở đâu.
   - (2) Cách cất bản nháp: đề xuất giữ file patch, viết lại từ test ở 4a.
   - (3) Hạn mức ngày là quy tắc tiền: con số và mốc nửa đêm giờ Việt Nam lấy từ nguồn nào.
   - (4) Các phụ thuộc và các dòng backlog cùng module.

## 3. Căn cứ trong skill

| Quyết định | Căn cứ (`git show main:…`) |
|---|---|
| Phải dùng skill, đủ 5 phase và 4 gate | `CLAUDE.md:3` «Trước khi sửa **bất kỳ** file nào… dùng skill `dbs-delivering-task`… Lời dặn "cứ làm thẳng"… không thay cho gate» |
| Câu "chỉ cần viết test và docs" không thay được gate | `SKILL.md:27` «Instructions given earlier… pass no gate: acknowledge them, still stop.»; `SKILL.md:81` |
| Viết lại code từ test, không giữ code viết trước | `SKILL.md:65` «Code written before its test is deleted and rewritten from the test.» |
| Cách chứng minh test bắt được lỗi: thấy đỏ trước | `SKILL.md:65` «Write the failing test, run it, confirm it fails for the right reason…»; `SKILL.md:61` «the test written first (and its one-line red failure once run)» |
| Chưa viết code production trước G3 | `SKILL.md:61` «No production code before G3.» |
| Chưa push hay mở PR; Draft chỉ khi được yêu cầu sau G3 | `SKILL.md:29` «Nothing reaches GitHub before G3… After G3 only a Draft PR, and only if the human asks»; `CONTRIBUTING.md:14` |
| PR ready sau G4; không merge, không sửa board | `SKILL.md:75`; `CLAUDE.md:7` |
| Nhờ người dùng chuyển board sang In Progress | `SKILL.md:45` «Ask the human to set the board row to "In Progress".» |
| Lấy task bằng fetch-task, không đoán DoD | `SKILL.md:45`; `SKILL.md:89` «if it fails, ask the human to paste the row. Never guess the DoD.» |
| Đọc tài liệu rồi mới tới code; grep nơi gọi | `SKILL.md:49` |
| Guard hạn mức ngày đặt sau lock | `references/module-notes.md:9` «guards **after** the lock (ACTIVE, per-transfer limit, day limit, balance)» |
| Hạn mức là quy tắc tiền, là extra gate | `SKILL.md:25` «stop and ask before changing… a money rule (CONTRIBUTING §5)» |
| Test tiền chạy PostgreSQL thật; mốc nửa đêm dùng clock inject | `SKILL.md:65` «Money tests run on real PostgreSQL, never a mock.»; `references/testing.md:37` «Midnight boundary: inject the clock» |
| Nhánh từ `main`; baseline đỏ thì báo ở G1 | `SKILL.md:50` |
| Không stub phần mà task phụ thuộc phải giao | `SKILL.md:48` «Never stub a guard, service or interface that an unfinished task is meant to deliver» |
| Feature doc trước code; G1 sau §1 | `SKILL.md:10`, `SKILL.md:51`; `SKILL.md:88` «I'll write the doc after the code» là red flag |
| Mẫu gate message, câu hỏi có đề xuất | `SKILL.md:33-38` |

**Chỗ skill không quy định:**
- **Code do người dùng viết sẵn** (không phải agent viết) có được miễn quy tắc xóa và viết lại không: skill không quy định. Câu ở `SKILL.md:65` không phân biệt ai viết, nên mình áp dụng như nhau.
- **Cách "xóa" mà không làm mất công của người dùng:** skill không quy định. Mặc định: lưu bản diff nguyên vẹn vào scratchpad, không dùng `git stash` trần, không đụng working tree của người dùng trước G3.
- **Có được đọc bản nháp làm tham khảo không:** skill không quy định. Mặc định: đọc ở Phase 1 như "code" cần hiểu (`SKILL.md:49`), đối chiếu ở Phase 2, nhưng code vào PR được viết từ test.
- **Cách khác để chứng minh test trên code giữ lại** (mutation test, cố tình làm hỏng code): skill không quy định. Mặc định: không dùng, vì code không được giữ lại.
- **Trường hợp người dùng nói có code chưa commit mà không tìm thấy:** skill không quy định. Mặc định: báo kết quả `git status` và hỏi ở G1; Phase 1 vẫn làm tiếp vì không phụ thuộc vào bản nháp.
````
