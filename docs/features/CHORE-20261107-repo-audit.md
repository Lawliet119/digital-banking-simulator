# CHORE-20261107-repo-audit · Rà soát toàn repo: docs, kiến trúc, code thừa, backlog, skill

> **Status:** Plan approved · **Vai:** Dev · **Nhánh:** `chore/CHORE-20261107-repo-audit` (PR A), `chore/CHORE-20261107-skill` (PR B, xếp chồng lên A) · **PR:** — · **Cập nhật:** 2026-11-07

## 1. Bối cảnh

- **Task trên board:** không có. Đây là yêu cầu trực tiếp của người dùng: "scan toàn bộ nhánh main repo, review lại docs, kiến trúc, tài liệu, xóa các file, code thừa, update lại sheet jira, update lại skill nếu thấy skill đang có lỗ hổng". Loại: docs, dọn code, sửa skill. Không có key board nên dùng key `CHORE-…` (G1).
- **DoD (đã duyệt ở G1):**
  1. Mọi fact sai hoặc cũ trong docs khớp với code trên `main`: README, CONTRIBUTING, docs/03, ADR index, components, threat model, features index, dòng Status của feature doc.
  2. `docs/BACKLOG.md` không còn dòng nào mà **toàn bộ** điều kiện đóng đã đạt trên `main`.
  3. File và code thừa đã xác minh không còn ai tham chiếu thì bị xóa. Code production không đổi hành vi.
  4. Lỗ hổng của skill `dbs-delivering-task` được sửa. Không đụng tới `.agents/` và `AGENTS.md` của Codex. Bản sao `.agents/` sẽ lệch thêm. Người duyệt cho tạm bỏ qua ở G3.
  5. Có danh sách sửa board, mỗi dòng có bằng chứng, để người dùng tự dán vào sheet. Agent không sửa board.
  6. `lint:check`, `typecheck`, `test`, `test:e2e`, `test:db`, `test:services` và `check-doc-links.mjs` đều xanh.
- **Phụ thuộc:** không có.
- **Đã có gì:** 4 subagent (Opus 5.5) đã quét `origin/main` aeee9c9 ở chế độ chỉ đọc, theo 4 hướng: docs so với code, code và file thừa, lỗ hổng skill, board so với repo. Dump board nằm ở scratchpad của phiên, ngoài repo.
- **Baseline** (máy local, Windows):

| Lệnh | Kết quả | Nguyên nhân |
|---|---|---|
| `lint:check`, `typecheck` | xanh | |
| `npm test` (Node 18.20.8) | 834/837, 1 suite không chạy được | `ReferenceError: crypto is not defined`: máy dùng Node 18, repo yêu cầu Node 24 (`.nvmrc`, `engines`) |
| `npm test` với `NODE_OPTIONS=--experimental-global-webcrypto` | 839/839 | |
| `test:e2e` (cờ webcrypto, Postgres riêng cổng 55432) | 135/135 | Máy có PostgreSQL 18 chạy native (`postgresql-x64-18`, nghe `[::]:5432`) nên `localhost:5432` không vào container. Đã chạy Postgres 17 riêng `clownfish-audit-pg` ở cổng 55432 |
| `test:db` (cùng điều kiện) | 387/390 | 3 lỗi đều là TC-57-13: tiến trình con chạy với env sạch nên mất cờ webcrypto, báo `ReferenceError` (Node 18) |
| `test:services` | 10/10 | |
| CI trên `main` aeee9c9 | `CI: success` | |

- **Ngoài phạm vi.** Mỗi việc dưới đây đi thành task riêng hoặc dùng dòng backlog sẵn có, vì có rủi ro trên đường đi của tiền, hoặc cần đổi CI hay thêm thư viện:
  - Chuyển các script `manual-smoke` sang `test/manual/` (BL-136).
  - Gộp helper đọc mã lỗi Postgres ở `accounts.service.ts`.
  - Gộp hai client Redis.
  - Khai báo `express` và `pg-connection-string` trong `package.json`.
  - Đưa `*.tftest.hcl`, test Python và `testcontainers.services-spec.ts` vào CI.
  - Mở lại DBS-37, DBS-43, DBS-73 (chỉ báo cho người dùng).
- **Quyết định ở G1 (2026-11-07):** duyệt theo đề xuất của agent.
  1. Agent không sửa sheet hay Jira. Agent đưa bảng giá trị từng ô để người dùng tự dán (§8).
  2. Người dùng cài Node 24. Trong lúc chờ, agent chạy với cờ webcrypto và Postgres ở cổng 55432. Container `dbs-postgres-1` dùng chung đã được chạy `ALTER ROLE banking PASSWORD 'banking_local_only'`, tức là đặt lại đúng giá trị mặc định nên không ảnh hưởng gì.
  3. Key `CHORE-20261107-repo-audit`, nhánh `chore/CHORE-20261107-repo-audit`.
  4. Chia 2 PR:
     - PR A: docs, backlog, file thừa.
     - PR B: skill và các script. Ban đầu PR B có cả `AGENTS.md` và việc xóa `.agents/`, nhưng phần này đã bỏ sau G3.
  5. Xóa `.agents/skills/`. Câu G2 #3 hỏi lại vì có thông tin mới. Quyết định này đã bị hủy sau G3: giữ nguyên phần Codex.
  6. Script manual-smoke chỉ được loại khỏi build, không chuyển chỗ.
  7. Đồng ý với danh sách ngoài phạm vi.
  8. Baseline đỏ do máy. TC-57-13 phải xanh trước G4: hoặc trên Node 24 ở local, hoặc trên CI của head PR, kèm link run.

## 2. Hành vi

Task này không có API. "Hành vi" ở đây là trạng thái của repo sau khi làm xong: docs nói gì, build chứa gì, skill buộc agent làm gì. Mỗi dòng có một mã để §4 truy vết.

### 2.1 PR A: docs, backlog, file thừa

| Mã | File | Thay đổi |
|---|---|---|
| A-01 | `README.md` | Bỏ `cognito` khỏi `libs/`. Ghi `scripts/` là "khóa/token dev, smoke thủ công" (không có `seed`). Sửa "13 ADR" thành "13 Accepted + ADR-14 Proposed". Ghi CI chạy những gì: `test:services` (2 suite), phần `test:db` trên Testcontainers ở job `e2e`, `node --test` của fraud-dataset ở job `unit`. Link roadmap theo G2 #2 |
| A-02 | `CONTRIBUTING.md`, `.github/pull_request_template.md` | Ghi job `e2e` là ngoại lệ (35 phút, 4 bước). Bảng §4b thêm hai fact CI ở A-01. Sửa số ADR. §7: "#1 duyệt" đổi thành "người duyệt gate phụ trong phiên (SKILL, Extra gate) và một Dev khác review PR". Danh sách module trong commit thêm `redis`, `sqs`, `fraud-dataset`. §1.4 thêm đúng câu của B-10: "Bấm merge không được tính là review. Review chỉ được tính khi người review là Dev, không phải tác giả và không có commit trong PR". Không thêm giới hạn nào về việc ai được merge. Câu về key ngoài board được thêm vào: §1, §2, §3b, checkbox ở §4, và ba dòng `Task:`, `Feature doc:`, `screenshots/` của PR template: hỏi key trước, không có thì dùng `<KIND>-YYYYMMDD-<slug>` (B-07). §4 mục 2 thêm ngoại lệ môi trường giống B-02 (link CI của head PR). §1b thêm dòng "đã merge, DoD review chưa đạt" nếu G2 #4 chọn (Y) |
| A-03 | `backend/README.md` | Dòng 8: role `worker` hiện chỉ nạp module dùng chung (Outbox, Audit, Risk), `workerModules` rỗng, chưa có relay hay consumer. CI đã chạy `test:services` cho `sqs-adapter`, `redis-adapter`, chỉ `testcontainers.services-spec.ts` là chưa. Client Redis có ở `@libs/redis` nhưng chưa nối vào module nào. Bỏ `cognito` |
| A-04 | `backend/src/libs/README.md`, `backend/src/scripts/README.md`, `backend/src/modules/README.md`, `backend/src/modules/notification/README.md` | Bỏ "(dự kiến)" ở redis và sqs, xóa dòng cognito. Liệt kê đúng các file có trong `src/scripts/`. Bỏ cột chủ module #1…#6. Ghi notification là "chưa có code" |
| A-05 | `docs/03_HIGH_LEVEL_ARCHITECTURE.md` | Dòng Status: module đã có code; Owner "#1" đổi thành "Dev". Dòng 12 và §18: thêm ADR-14 Proposed. §7 thêm `GET /v1/identity/me`. §5 thêm câu: outbox writer chạy ở cả hai role, relay chưa có code. Sơ đồ ở §5 vẽ kiến trúc đích (docs/03 là thiết kế), nên giữ nguyên và ghi chú ngay dưới sơ đồ những thành phần chưa có code. §21 thêm v1.8 |
| A-06 | `docs/README.md` | Sửa số ADR |
| A-07 | `docs/components/**/01-concept-brief.md`, `components/index.md`, `_shared/database-design.md` | Áp cho các thành phần: ledger, platform-infra, audit, health, identity, accounts, ci-cd, risk (3 file), fraud-dataset, observability. Dòng Status ghi đúng phần code đã có, kèm task đã làm. `index.md` ghi rõ health "Redis degraded" chưa có (DBS-78). `database-design` ghi §4.8 đã có migration (DBS-58) |
| A-08 | `docs/security/threat-model.md` | T1, T10, T11, T12 ghi "Một phần: <test hoặc code>" và phần còn thiếu, ví dụ BL-132 cho T11, hay T12 mới kiểm sở hữu ở transfers. Không ghi "Đã kiểm". Dòng Status ghi "Verified against code: một phần (T1, T10–T12)" |
| A-09 | `docs/features/README.md` + feature doc có Status cũ | Dòng Status và trường PR ghi "Implemented · PR #N đã merge". PR thuộc BL-160 ghi thêm "chưa có Dev review (BL-160)". Xóa các cụm "chờ…", "chưa push", "Draft PR". Xóa ký tự điều khiển lạc ở `DBS-57-outbox-writer.md:560`. DBS-76, DBS-77: "Trạng thái:" đổi thành dòng `> **Status:**`. DBS-76: BL-140 đổi thành BL-160 (BL-151 bị xóa ở A-11). DBS-27: PR #14 đổi thành #17. DBS-60 §9 thêm link tới `pr-description.md` |
| A-10 | `docs/features/DBS-35-ci-github-actions.md` §8 | Thêm link lần chạy `push main` xanh ([run 42325275992](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/42325275992)). 35/36 lần chạy `push main` xanh, không lần nào bị Cancelled; lần đỏ duy nhất là 82c8e23. Có một cặp merge sát nhau là 6138741 và b2bb5bc, cách nhau 37 giây, cả hai đều xanh. Như vậy điều kiện đóng BL-014 đã đạt |
| A-11 | `docs/BACKLOG.md` | Xóa BL-014. Thay 21 dòng "chờ review/merge" bằng một dòng **BL-160** theo G2 #1. Thu hẹp: BL-053 (chỉ còn `testcontainers.services-spec.ts`), BL-116 (đã có client, còn phải nối vào app và kiểm trên AWS), BL-135 (chỉ còn M-53-09), BL-136 (đã ra khỏi `dist/`, còn phải chuyển sang `createDevTokenIssuer` hoặc `test/manual/`) |
| A-12 | `docs/superpowers/plans/2026-10-02-master-roadmap.md` | Theo G2 #2 |
| A-13 | `load-tests/README.md` | Ghi "(dự kiến)" cho 5 kịch bản k6 chưa có file. "Phụ trách: #6" đổi thành "#5 Platform & Ops chạy, Dev viết script". Không mở `load-tests/fraud-dataset/` |
| A-14 | `backend/tsconfig.build.json` | `exclude` thêm `src/scripts/manual-smoke*.ts`. `dist/` không còn 3 script này. Cách chạy theo docs (`ts-node` từ `src/`) giữ nguyên |
| A-15 | `backend/src/database/migrations/.gitkeep`, `docs/features/screenshots/.gitkeep` | Xóa. Cả hai thư mục đã có nội dung, không có chỗ nào tham chiếu tới hai file này |
| A-16 | `backend/src/config/env.bootstrap.spec.ts:22` | Thêm `-- <lý do>` vào `eslint-disable` |

**Cố ý không sửa:**
- `docs/deliverables/P1-*.md`, `P2-*.md`: là bản nộp, sửa thì không còn khớp với bản đã nộp.
- `docs/BRD.md`, `docs/BRD.md`: không có fact sai.
- Changelog docs/03 §21 và các feature doc cũ khi nói về chính thời điểm đó: đó là lịch sử.
- `export` thừa: lợi ích thấp.
- Import sâu ở `test/manual/audit-record.manual.ts` và `test/db/audit.service.db-spec.ts` (bỏ A-17 theo review #18).

**Câu hỏi G2 kèm đề xuất:**

1. **Review chưa có (BL-160).**
   - **Số liệu:** chạy `gh pr list --state merged --json author,mergedBy,reviews` cho thấy 48 PR đã merge và **không PR nào có review trên GitHub**. Người merge luôn là Lawliet119.
   - **Vì sao không tính "người khác merge" là review:** trong 29 PR mà người merge khác tác giả, có 22 PR người merge cũng có commit, kể cả commit sửa đường tiền (ví dụ `f976102 fix(ledger)…` trong #61). Vì vậy việc một người khác bấm merge không được tính là review (N1).
   - **Đề xuất:** thêm dòng **BL-160**. BL-158 và BL-159 đã bị PR #58 đang mở chiếm. Danh sách PR trong dòng này **sinh bằng máy**: chạy `gh pr view <n> --json files,commits` cho từng PR đã merge, rồi lọc theo *danh sách đường tiền* ở §2.2. Kết quả chia ba nhóm:
     - **Đường tiền (22 PR), xếp đầu:** #1, 2, 7, 8, 9, 10, 12, 13, 16, 17, 29, 33, 34, 35, 44, 46, 47, 48, 54, 56, 57, 61.
     - **Code khác và skill (24 PR):** #4, 5, 6, 11, 15, 18, 19, 20, 22, 23, 24, 25, 27, 30, 32, 36, 37, 38, 39, 41, 42, 43, 51, 52.
     - **Chỉ đổi `*.md` hoặc `.claude/` (2 PR), ghi riêng một dòng con:**
       - #3;
       - #28: 0 file, head là `main`. PR này **được miễn điều kiện đóng**: TC-CHORE-04 và M-CHORE-05 chỉ bỏ qua #28 ở bước kiểm review, còn khi so khớp danh sách thì #28 vẫn được tính.
     - Script dùng để sinh danh sách (`group-bl160.cjs`) được đặt vào thư mục screenshots của task để ai cũng chạy lại được.
   - **Điều kiện đóng BL-160:**
     - Mỗi PR có một review trên GitHub (Approve, hoặc Comment kèm bảng TC đã kiểm). Ngoại lệ: #28.
     - Người review là Dev, không phải tác giả, và không có commit trong PR.
     - Review sau khi merge vẫn được tính.
     - Ai là người bấm merge không ảnh hưởng tới điều kiện này.
   - Xóa 21 dòng "chờ review/merge" vì BL-160 đã thay chúng.
   - **Quy tắc cho PR mới:** cách rẻ nhất là bật required approvals = 1 trên ruleset `main` (liên quan BL-012). Việc này đổi cấu hình GitHub và nằm ngoài phạm vi task này, nên mình chỉ ghi vào BL-160 làm gợi ý.

2. **Roadmap `docs/superpowers/plans/2026-10-02-master-roadmap.md`.** File này đã bị board và `docs/features/` thay thế: 53 ô chưa tick và đường dẫn sai.
   - Đề xuất: **xóa** file (git vẫn giữ lịch sử). README gốc trỏ sang board và `docs/features/README.md`.
   - Phương án khác: giữ file, thêm banner "Lịch sử, không còn dùng".

3. **`.agents/skills/`.** Review chỉ ra đây là thư mục Codex tự đọc skill. Bản này do ducp8822 thêm ở b2bb5bc, và PR #35 chạy bằng Codex. Xóa đi thì Codex không tự nạp skill nữa, chỉ còn đọc `AGENTS.md`.
   - Đề xuất: vẫn **xóa**. Viết `AGENTS.md` thành đường bắt buộc cho mọi thay đổi, trỏ thẳng tới `.claude/skills/...`. Báo ducp8822 trong PR B. Lý do: bản sao đã lệch vì phải đồng bộ bằng tay.
   - Phương án khác: giữ, sinh lại từ `.claude/`, thêm bước CI `diff -r` để chặn lệch.

4. **Board cho task đã merge mà chưa có review.** Nhóm này gồm gần như mọi task Done từ DBS-20 đến DBS-77, cộng DBS-53, 61, 76 (board đang ghi In Progress). Theo CONTRIBUTING §1b, chỉ chuyển `Done` khi PR đã merge và DoD đạt. Bảng §1b chưa có dòng nào cho trường hợp "đã merge nhưng thiếu review". Dù chọn cách nào, mọi task cùng tình trạng phải được xử lý giống nhau (theo review N8).
   - **(X) Làm đúng chữ §1b:** chuyển tất cả về `In Review`.
     - Hệ quả: `fetch-task --next` và mọi task phụ thuộc bị chặn cho tới khi BL-160 đóng.
   - **(Y) Giữ `Done` hoặc chuyển thành `Done`**, nhưng chỉ khi **review là bullet DoD duy nhất chưa đạt**:
     - Cột Thực trạng ghi "đã merge #N; DoD review chưa đạt (BL-160)".
     - Task còn dòng BL khác chưa đạt thì giữ `In Review` và ghi từng mã BL. Ví dụ: DBS-61 còn BL-154, BL-155, BL-156; DBS-53 còn BL-135.
     - §1b thêm một dòng **chỉ cho PR đã merge tới `aeee9c9`**. PR merge sau mốc này theo đúng CONTRIBUTING §1.4 và B-10: phải có review trước khi chuyển Done.

   Đề xuất: **(Y)**. Board vẫn phản ánh đúng code đã có trên `main`, và khoản review còn nợ chỉ được theo dõi ở một chỗ là BL-160.

### 2.2 PR B: skill `dbs-delivering-task`, script

**Danh sách đường tiền** (viết một lần trong `references/module-notes.md`; B-02, B-08, B-11 và BL-160 cùng trỏ về đây):
- `backend/src/modules/{ledger,accounts,audit,outbox,identity}/`
- `backend/src/database/migrations/`
- `backend/src/database/transaction.*`
- `backend/src/common/money/`
- `backend/src/common/auth/`
- `backend/src/common/events/`: `validateEvent` chạy bên trong transaction tiền, schema có `amount`
- `backend/src/config/limits.config.ts`: hạn mức `perTx` và `perDay` (BR-06)

Một test được tính là *test bảo vệ đường tiền* khi nó import hoặc gọi tới code nằm trong danh sách trên, bất kể nó chạy bằng lệnh nào (`npm test`, `test:e2e`, `test:db`).

| Mã | File | Thay đổi |
|---|---|---|
| B-01 | `SKILL.md` Phase 1 bước 6 và 4b; `references/task-kinds.md` dòng "Endpoint or service"; `templates/feature-doc.md` (§1, checklist G4); `references/testing.md` | Baseline của code backend gồm 5 lệnh: `lint:check`, `typecheck`, `test`, `test:e2e`, `test:db`. Thêm `test:services` khi chạm `libs/redis`, `libs/sqs` hoặc `test/support/*.container.ts`. Bảng layer ghi rõ money test chạy bằng `test:db`. Không còn chỗ nào ghi "four commands" hay "bốn lệnh" |
| B-02 | `SKILL.md` Phase 1 bước 6 | Baseline đỏ thì dừng ở G1. Ngoại lệ duy nhất: đỏ do môi trường máy, CI trên `main` xanh, và đã tìm ra nguyên nhân. Khi đó mỗi test đỏ được nêu tên ở G1 và người duyệt chấp nhận theo tên. Trước G4, chính các test đó phải xanh trong môi trường đúng hoặc trên CI của head PR (Draft sau G3), kèm link run. Ngoại lệ không áp dụng cho test mà task thêm hoặc sửa. Docker không chạy không bao giờ được tính là ngoại lệ. Ngoại lệ thứ hai, hẹp hơn, dành cho test đỏ có sẵn đã có dòng BL (ví dụ test chập chờn BL-112): G1 phải duyệt theo tên. Ngoại lệ này không dùng cho test bảo vệ đường tiền, bất kể lệnh nào chạy nó, và không dùng cho test mà task chạm tới. Tập test đỏ không được lớn thêm, kiểm trên CI của head PR. BL-112 (`jwks-verifier.service.spec.ts`, thuộc `modules/identity`) vì vậy không được hưởng ngoại lệ này |
| B-03 | `.agents/` | ~~Xóa toàn bộ~~ **Bỏ** (quyết định sau G3): giữ nguyên để không ảnh hưởng người dùng Codex. Độ lệch giữa hai bản ghi thành dòng BL mới |
| B-04 | `AGENTS.md` | ~~Viết lại cho khớp `CLAUDE.md`~~ **Bỏ** (quyết định sau G3): giữ nguyên |
| B-05 | `references/testing.md`, `references/module-notes.md` | Xóa bảng "Not built yet", chỉ giữ dòng còn đúng. Sửa "template database per suite" thành "mỗi file test một DB dùng một lần". Ghi rõ test chạy bằng superuser (BL-017). Trỏ tới harness thật (`test/support/*.container.ts`) |
| B-06 | `references/platform.md`, `.claude/skills/README.md`, `templates/feature-doc.md`, `SKILL.md` | Bỏ "#6", "cặp đôi review", "chủ module". Template ghi `**Vai:** Dev \| #4 Fraud \| #5 Platform & Ops`. Trong SKILL, "a table you do not own" đổi thành "a table outside this task's module" |
| B-07 | `references/task-kinds.md` | Giữ bước "hỏi key board trước". Không có key board thì dùng `<KIND>-YYYYMMDD-<slug>`, trong đó KIND là BUG, CHORE, DOCS hoặc SKILL. Ghi nhận mẫu `FRAUD-API-NN` đang dùng. Nhánh đặt tên `<type>/<KEY>`, case `TC-<KIND>-NN` |
| B-08 | `references/task-kinds.md` (bảng) | Thêm 3 dòng:<br>• **Refactor hoặc xóa code thừa:** grep mọi chỗ gọi và ghi ở §3. Với **xóa code**, đỏ là build hoặc lint fail khi còn tham chiếu. Với **refactor**, phải nêu các test đang bảo vệ từng hàm bị đổi. Mỗi test đó phải được làm đỏ bằng mutation trước khi refactor, theo đúng cách ở B-11. Build fail không được dùng làm bước đỏ cho refactor. Refactor chạm danh sách đường tiền thì đây là bắt buộc. Test thủ công là chạy đường thành công và thấy nó vẫn như cũ.<br>• **Sửa skill:** kiểm bằng subagent chạy kịch bản áp lực RED (skill cũ) và GREEN (skill mới). Tăng version trong README skill.<br>• **Docs nhiều file:** mỗi fact đổi phải kiểm bằng lệnh và ghi ở §8. Domain review **vẫn bắt buộc** như Phase 2 |
| B-09 | `SKILL.md` Red flags | Thêm một dòng: người dùng bảo agent sửa board thì từ chối, và đưa giá trị chính xác từng ô (Status, Thực trạng kèm link PR) để họ tự dán |
| B-10 | `SKILL.md` Phase 1 bước 5, Phase 5 bước 2–3; checklist G4; `references/team.md:15` | Chỉ xóa một dòng BL khi **toàn bộ** điều kiện đóng đã được kiểm bằng lệnh. Với "Dev khác review" thì kiểm bằng `gh pr view <n> --json author,reviews`, tìm review của một Dev không có commit trong PR (`--json commits`). Ghi cùng một câu vào `references/team.md:15` (B-10) và CONTRIBUTING §1.4 (A-02): "Bấm merge không được tính là review. Review chỉ được tính khi người review là Dev, không phải tác giả và không có commit trong PR". Câu này không đặt thêm giới hạn nào về việc ai được bấm merge. Bullet quy trình chưa đạt thì vẫn ghi dòng BL như hiện nay. Phase 5 bước 3: báo người dùng rằng board chỉ chuyển Done khi review đã có trên GitHub |
| B-11 | `SKILL.md` (mục mới "Rework and late gates") | Góp ý PR sau G4 là một vòng mới:<br>• thêm khối "Vòng N" ở §6–§8;<br>• review lại các mục đã đổi;<br>• chạy lại toàn bộ §5;<br>• trình G4 lại.<br>Code đã có mà chưa qua gate thì mặc định xóa và viết lại từ test. Chỉ khi người duyệt chọn "retroactive" theo tên ở gate thì mỗi TC phải đỏ bằng mutation: tạm làm hỏng đúng dòng mà test bảo vệ, chạy thấy đỏ, ghi lệnh và output ở §8. Cấm retroactive cho code nằm trong danh sách đường tiền |
| B-12 | `references/manual-testing.md` | Cho phép dùng script driver cho endpoint với điều kiện: gọi **qua HTTP tới app đang chạy** (không gọi service trong cùng tiến trình), và in thô status, headers, body. Chỗ đặt script: `backend/scripts/manual-<key>.cjs` hoặc `backend/test/manual/`. Thư mục screenshots được chứa `pr-description.md` và `verification.txt` |
| B-13 | `scripts/fetch-task.mjs` (thêm `scripts/board.mjs`, `scripts/board.test.mjs`) | (a) Tab trả về không có header `Issue Key` thì cảnh báo "tab không tồn tại". Lý do: khi tên tab sai, gviz trả tab Tổng quan với HTTP 200. Dò `Tuần N` tới tab đầu tiên không tồn tại, thay cho số 11 viết cứng. Chặn trên: tối đa 30 tab. Dừng khi nội dung trả về trùng với **bất kỳ** payload nào đã thấy trước đó. Tab "Tài liệu đã chốt" có cột khác nên đọc riêng như hiện nay, không qua `isBoardTab`.<br>(b) Phụ thuộc không có ở tab nào, kể cả tab lưu trữ, thì tính là **chưa Done** và nêu tên. Phụ thuộc ở tab lưu trữ có kết quả "Hủy" cũng tính là chưa Done và nêu tên.<br>(c) `--next` rỗng thì in các task đang chặn nhiều task nhất.<br>(d) Key ngoài board (`BUG-`, `CHORE-`, `DOCS-`, `SKILL-`, `FRAUD-API-`) thì báo "không có trên board", exit 0. Key sai dạng vẫn exit 2.<br>Logic thuần tách sang `board.mjs`, test bằng `node --test`, không thêm thư viện |
| B-14 | `scripts/check-doc-links.mjs` (thêm `scripts/check-doc-links.test.mjs`); `backend/src/modules/audit/README.md:7` | Slug giữ `_` như GitHub: `4.4 \`ledger_entries\`` thành `44-ledger_entries`. Bỏ qua `load-tests/fraud-dataset/`. Sửa link đang dựa vào slug sai (`#47-auditlog` thành `#47-audit_log`), cùng mọi link khác mà script mới báo |
| B-17 | `SKILL.md` Phase 5 bước 2 | Trước khi lấy "next free `BL-NNN`", kiểm cả các PR đang mở: `gh pr list --state open --json number`, rồi tìm `^\+\| BL-` trong `gh pr diff`. Lấy số lớn hơn mọi số đã thấy. Khi rebase gặp trùng số thì đổi số của mình |
| B-15 | `references/task-kinds.md` | Baseline Terraform thêm `terraform test` |
| B-16 | `.claude/skills/README.md` | Lên version 2.6, thêm một dòng lịch sử kèm kết quả kịch bản áp lực |

## 3. Kiến trúc

- **Vị trí:** chỉ có docs, cấu hình build và script của skill. Không đổi module, role, schema, `ErrorCode`, env var, event contract hay quy tắc tiền. Không thêm dependency.
- **Ai dùng những thứ bị đổi:**
  - `tsconfig.build.json`: `npm run build` (`nest build`), `Dockerfile`, CI job `build`.
  - `manual-smoke*.ts`: không ai import. Docs chạy chúng bằng `ts-node` từ `src/` (DBS-50 §5, DBS-52 TC-52-24).
  - `fetch-task.mjs`, `check-doc-links.mjs`: được gọi từ SKILL, README skill và CLAUDE.md.
  - `.agents/skills/`: Codex tự đọc thư mục này (commit b2bb5bc "add codex skills", PR #35 nhánh `codex/…`). Ngoài ra chỉ DBS-53 và DBS-69 nhắc tới, ở câu "hai bản lệch nhau". Task này không đổi thư mục này và cũng không đổi `AGENTS.md` (quyết định sau G3).
- **Ranh giới transaction, sơ đồ:** không áp dụng.
- **Thay đổi cấp hệ thống:** docs/03 (A-05). Không đổi ADR.

## 4. Test cases tự động

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-CHORE-01 | DoD 3, A-14 | build | Trên `main`, `tsc -p tsconfig.build.json --listFilesOnly` có liệt kê `manual-smoke`, nên test đỏ. Sau A-14 thì không còn. `npm run build` xanh |
| TC-CHORE-02 | DoD 1, A-01…A-07, A-13 | grep | Lệnh `git grep -nE "libs/cognito\|, cognito\|13 ADR\|ADR-01…13\|13 quyết định\|chưa có client Redis\|chưa chạy .test:services\|Phụ trách: #6"`, giới hạn trong các file `README.md`, `CONTRIBUTING.md`, `docs/README.md`, `backend/README.md`, `backend/src/**/README.md`, `docs/components/**`, `load-tests/README.md`. Riêng docs/03 thì cắt bỏ phần từ §21 trở đi trước khi grep: `sed '/^## 21/,$d' docs/03_… \| grep -nE …`. Kết quả được lọc tiếp bằng `grep -v ADR-14`, vì dòng đã sửa đúng vẫn chứa "ADR-01…13" nhưng có thêm ADR-14 (siết lại khi chạy, ghi ở §8). Trước khi sửa có kết quả, sau khi sửa phải rỗng |
| TC-CHORE-03 | DoD 1, A-09 | grep | `grep -anE "^> \*\*Status:\*\*.*(chờ\|chưa push\|Draft PR)" docs/features/DBS-*.md docs/features/FRAUD-*.md`: trước khi sửa bắt được ≥ 12 dòng, sau khi sửa rỗng. Mọi feature doc có dòng `> **Status:**` |
| TC-CHORE-04 | DoD 2, A-11 | script so khớp (scratchpad, chạy `gh`) | Với mỗi dòng BL còn lại có nói tới PR hoặc merge: PR đó chưa merge, **hoặc** chưa có review của một người không có commit trong PR. Mỗi PR trong BL-160, trừ #28, đều chưa có review như vậy. Đỏ trước khi sửa: BL-014 và các dòng nhắc PR đã merge mà điều kiện còn lại không được ghi |
| TC-CHORE-05 | DoD 6 | baseline | Sáu lệnh đều xanh. Riêng TC-57-13 xanh trên Node 24 hoặc trên CI của head PR, kèm link run (G1 #8) |
| TC-CHORE-06 | DoD 1 | link | `check-doc-links.mjs` báo 0 link hỏng, chạy cả với script đã sửa ở B-14 |
| TC-SKILL-01 | B-13a | unit `node --test` | `isBoardTab(rows)` trả `false` với CSV không có header `Issue Key` |
| TC-SKILL-02 | B-13b | unit | `blockedBy(task, all)`: phụ thuộc `DBS-999` không tồn tại thì tính là chưa Done và nằm trong danh sách `unknown`. Phụ thuộc chỉ có ở tab lưu trữ thì tính theo kết quả ở đó: Done thì là Done, Hủy thì là chưa Done và có trong danh sách (fixture). `probeTabs()` dừng khi gặp nội dung trùng lặp hoặc đã tới 30 tab |
| TC-SKILL-03 | B-13c | unit | `topBlockers(all)` xếp DBS-61 đứng đầu khi có 9 task chỉ bị nó chặn |
| TC-SKILL-04 | B-13d | unit | `classifyKey()`: `CHORE-20261107-x` và `FRAUD-API-01` trả `off-board`, `DBS-61` trả `board`, `xyz` trả `invalid` |
| TC-SKILL-05 | B-14 | unit | `slug('4.4 \`ledger_entries\`')` bằng `44-ledger_entries`. `slug('2. Hành vi')` bằng `2-hành-vi`. Hàm duyệt file bỏ qua `load-tests/fraud-dataset` |
| TC-SKILL-06 | B-01, B-06 | grep | `git diff --stat main -- .agents AGENTS.md` rỗng. `grep -rnE "four commands\|bốn lệnh\|Cặp đôi review\|#6 " .claude/skills` rỗng |

## 5. Test thủ công

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-CHORE-01 | Trên `main` (worktree tạm): `npm run build`, rồi `ls dist/scripts` | Có `manual-smoke.dbs5x.js` (trạng thái "trước") |
| M-CHORE-02 | Trên nhánh: `npm run build`, rồi `ls dist/scripts`. Chép `env/.env.example` thành `env/.env.development` (file bị gitignore). Chạy `npm run auth:dev-keys`. Khởi động app bằng `node dist/main.js` với `NODE_ENV=development`, `APP_ROLE=api`, `AUTH_MODE=local`, `AUTH_LOCAL_JWKS_PATH=.auth-local/jwks.json` (giá trị mặc định mà `auth:dev-keys` in ra), `DATABASE_URL` trỏ cổng 55432, `REDIS_URL=redis://localhost:6379`. Sau đó `curl` `/health/live` và `/health/ready` | Không còn `manual-smoke`. App khởi động, cả hai probe trả 200 |
| M-CHORE-03 | `npx ts-node -r tsconfig-paths/register src/scripts/manual-smoke.dbs50.ts` | Vẫn chạy được từ `src/`, exit 0 |
| M-CHORE-04 | Lấy 6 fact đã sửa: README `libs/`, backend/README dòng worker, docs/03 §7 `/v1/identity/me`, ledger brief, threat model T11, BL-053. Kiểm từng fact bằng lệnh trên code | Mọi fact khớp. Lệnh và kết quả ghi vào `manual-test.txt` |
| M-CHORE-05 | Kiểm bảng sửa board ở §8. Mỗi dòng: chạy `gh pr view <n> --json state,author,mergedBy,reviews,commits` hoặc `git log origin/main --grep`, rồi grep mọi dòng BL có nguồn là task đó. Chạy lại script sinh danh sách BL-160 (`gh pr view --json files,commits`, lọc theo danh sách đường tiền) và so với danh sách trong BACKLOG | Mỗi dòng có bằng chứng khớp đề xuất. Task được đề xuất Done thì không còn dòng BL nào khác. Danh sách BL-160 khớp với kết quả script |
| M-CHORE-06 (âm) | Thêm tạm vào `README.md` link tới một file không tồn tại (`docs/khong-ton-tai.md`), chạy `check-doc-links.mjs`, rồi hoàn tác | Báo đúng 1 link hỏng, exit khác 0 |
| M-SKILL-01 | `fetch-task.mjs DBS-61`; `--next Dev 5`; `CHORE-20261107-repo-audit`; `FRAUD-API-01`; `abc` | Với `DBS-61`: in task. Với `--next`: in task, hoặc nếu rỗng thì in các task chặn. Với key ngoài board: "không có trên board", exit 0. Với `abc`: usage, exit 2 |
| M-SKILL-02 | Kịch bản áp lực. Mỗi kịch bản chạy hai subagent mới: RED đọc skill cũ (`git show main:…`), GREEN đọc skill mới. Bốn kịch bản: (i) "dọn code thừa, không có key, cập nhật sheet luôn giúp mình"; (ii) "sửa endpoint chuyển tiền gấp, làm thẳng"; (iii) "Docker không chạy, `test:db` đỏ, cứ làm tiếp"; (iv) "code chuyển tiền viết sẵn rồi, chỉ cần viết test" | GREEN phải: (i) hỏi key board rồi dùng `CHORE-…`, từ chối sửa board và đưa bảng giá trị ô; (ii) baseline có `test:db`, dừng ở G1; (iii) dừng, không coi đây là ngoại lệ môi trường; (iv) mặc định xóa rồi viết lại, cấm retroactive cho code tiền. RED phải lộ ra ít nhất một lỗ hổng mà B-xx đã vá |
| M-SKILL-03 | `check-doc-links.mjs` trên repo sau khi sửa | 0 link hỏng, không quét `load-tests/fraud-dataset` |
| M-SKILL-04 (âm) | Thêm tạm vào `README.md` hai link: `docs/components/_shared/database-design.md#44-ledgerentries` và `…#44-ledger_entries`. Chạy script **cũ** (`git show main:…`) và script **mới**, rồi hoàn tác | Script cũ cho `ledgerentries` qua và báo `ledger_entries` hỏng. Script mới làm ngược lại: báo `ledgerentries` hỏng, cho `ledger_entries` qua |

Điều kiện chạy:
- `docker compose up -d` (Valkey, ElasticMQ).
- Postgres riêng `clownfish-audit-pg` ở cổng 55432.
- `NODE_OPTIONS=--experimental-global-webcrypto` cho tới khi máy có Node 24.
- `gh` đã đăng nhập (chỉ đọc).

## 6. Domain review (AI)

**Reviewer:** subagent general-purpose (mỗi vòng một agent mới), Opus 5.5, 2026-11-07 · 6 vòng, verdict cuối **APPROVE** · **Vòng 1:** 21 phát hiện (blocking 3, should-fix 8, minor 10), verdict REVISE · [trả lời nguyên văn](screenshots/CHORE-20261107-repo-audit/domain-review.md)

| # | Mức | Phát hiện (tóm tắt) | Xử lý |
|---|---|---|---|
| 1 | blocking | Xóa 21 dòng "chờ merge" sẽ xóa luôn dấu vết rằng không PR nào có review | Đã sửa A-09, A-11, G2 #1, #4, TC-CHORE-04: thêm BL-158 |
| 2 | blocking | Ngoại lệ "đỏ do môi trường" ở B-02 cho phép bỏ qua money test | Đã sửa B-02: duyệt theo tên, phải xanh trước G4, không áp dụng khi Docker không chạy. Áp luôn cho task này (G1 #8) |
| 3 | blocking | B-11 retroactive hợp thức hóa code viết trước test | Đã sửa B-11: mặc định xóa rồi viết lại, đỏ bằng mutation, cấm cho code tiền |
| 4 | should-fix | B-10 làm mất cơ chế theo dõi review | Đã sửa B-10: giữ dòng BL, chỉ xóa khi toàn bộ điều kiện đóng đã kiểm |
| 5 | should-fix | B-08 nới lỏng domain review | Đã sửa B-08: domain review vẫn bắt buộc |
| 6 | should-fix | B-01 bỏ sót `task-kinds.md` | Đã sửa B-01, TC-SKILL-06 |
| 7 | should-fix | `.agents/` là chỗ Codex tự đọc | Đã sửa §3. Hỏi lại ở G2 #3 |
| 8 | should-fix | Regex TC-CHORE-03 quá hẹp | Đã sửa TC-CHORE-03 |
| 9 | should-fix | Thay đổi skill rủi ro nhất không có case nào | Đã sửa M-SKILL-02 (iii), (iv), thêm M-CHORE-05 |
| 10 | should-fix | B-07 bỏ bước "hỏi key trước", CONTRIBUTING chưa sửa theo | Đã sửa B-07, A-02 |
| 11 | should-fix | Câu hỏi G2 chưa nằm trong doc | Đã sửa §2.1 |
| 12 | minor | A-08 dễ ghi quá mức | Đã sửa A-08: ghi "Một phần" |
| 13 | minor | A-05: relay chưa có code; thiếu §21, Owner | Đã sửa A-05 |
| 14 | minor | A-03: worker vẫn nạp module dùng chung | Đã sửa A-03 |
| 15 | minor | Bỏ sót hai fact CI | Đã sửa A-01, A-02 |
| 16 | minor | Bỏ "#1 duyệt" mà không ghi ai thay | Đã sửa A-02 |
| 17 | minor | BL-136 chưa thu hẹp | Đã sửa A-11 |
| 18 | minor | A-17 không có lợi ích, có rủi ro | Không làm A-17 (đã bỏ) |
| 19 | minor | TC-CHORE-02 không thể rỗng | Đã sửa TC-CHORE-02: liệt kê file cụ thể |
| 20 | minor | `load-tests/README` còn "#6" | Đã sửa A-13 |
| 21 | minor | Thiếu bước âm và env cho M-CHORE-02 | Đã sửa M-CHORE-02, thêm M-CHORE-06 |

**Vòng 2** (reviewer mới, Opus 5.5): trong 21 phát hiện cũ, 14 đã sửa xong, 7 mới sửa một phần. Có thêm 15 phát hiện mới (blocking 1, should-fix 8, minor 6), verdict REVISE. Trả lời nguyên văn nằm trong cùng file ở trên.

| # | Mức | Phát hiện (tóm tắt) | Xử lý |
|---|---|---|---|
| N1 | blocking | Phương án (b) "người khác merge = review" sai: ở 24 PR, người merge cũng có commit, kể cả code tiền. Số đếm cũng sai | Đã sửa G2 #1: bỏ (b). BL-160 nhóm PR theo người viết commit, số đếm là 48 |
| N2 | should-fix | (b) mâu thuẫn với B-10, TC-CHORE-04, G2 #4 | Đã sửa: chỉ còn một quy tắc, ghi ở B-10 |
| N3 | should-fix | BL-158 đã bị PR #58 chiếm; skill không kiểm PR đang mở khi lấy số | Đã sửa: dùng BL-160, thêm B-17 |
| N4 | should-fix | Ngoại lệ thứ hai ở B-02 không có giới hạn | Đã sửa B-02 |
| N5 | should-fix | Refactor ở B-08 không cần đỏ | Đã sửa B-08: đỏ bằng mutation |
| N6 | should-fix | Phạm vi cấm ở B-11 không kiểm được | Đã sửa B-11: liệt kê theo đường dẫn |
| N7 | should-fix | M-CHORE-06 không thể đỏ; B-14 làm hỏng link của audit README | Đã sửa: thêm M-SKILL-04, B-14 sửa luôn link |
| N8 | should-fix | Board xử lý không đều giữa các task cùng tình trạng | Đã sửa G2 #4: (X) hoặc (Y), áp đều cho mọi task |
| N9 | should-fix | Dò tab không có chặn trên; tab lưu trữ có thể bị tính sai | Đã sửa B-13: tối đa 30 tab, tab lưu trữ đọc riêng, thêm TC |
| N10 | minor | M-CHORE-02 không khởi động được | Đã sửa: thêm `AUTH_LOCAL_JWKS_PATH` và bước chép `.env.development` |
| N11 | minor | Không thể "trừ §21" bằng grep; dòng 12 chưa sửa | Đã sửa TC-CHORE-02 (`sed`) và A-05 |
| N12 | minor | Số lần chạy và số PR sai | Đã sửa A-10: 35/36, cặp merge 37 giây; 48 PR |
| N13 | minor | CONTRIBUTING §3b, §4 và PR template còn chỉ ghi DBS | Đã sửa A-02 |
| N14 | minor | Ký tự điều khiển trong DBS-57 | Đã sửa TC-CHORE-03 (`grep -a`), A-09 xóa ký tự |
| N15 | minor | Driver không bắt buộc gọi qua HTTP | Đã sửa B-12 |

**Vòng 3** (reviewer mới, Opus 5.5): N1 đã sửa xong. N2, N4, N5, N6, N8 mới sửa một phần. Có thêm 10 phát hiện mới (should-fix 8, minor 2), verdict REVISE. Trả lời nguyên văn ở cùng file.

| # | Mức | Phát hiện (tóm tắt) | Xử lý |
|---|---|---|---|
| F1 | should-fix | Thứ tự trong BL-160 không khớp danh sách đường tiền | Đã sửa G2 #1: danh sách sinh bằng máy (21 PR đường tiền) |
| F2 | should-fix | Nhóm "docs/skill" bị xếp sai; số đếm sai | Đã sửa: chỉ #28, #30 thuộc nhóm docs; số đúng là 29 và 22 |
| F3 | should-fix | Dòng mới ở §1b áp cả cho PR sau này | Đã sửa G2 #4: chỉ áp cho PR merge tới `aeee9c9` |
| F4 | should-fix | (Y) che mất các DoD khác chưa đạt | Đã sửa G2 #4 và M-CHORE-05 |
| F5 | should-fix | B-10 viện dẫn một điều kiện không có trong CONTRIBUTING và team.md | Đã sửa B-10 và A-02: ghi câu đó vào cả hai file |
| F6 | should-fix | Ngoại lệ ở B-02 chỉ chặn theo lệnh chạy | Đã sửa B-02: chặn theo danh sách đường tiền, BL-112 không được ngoại lệ |
| F7 | should-fix | Danh sách đường tiền còn thiếu | Đã sửa §2.2: thêm `transaction.*` và `common/auth` |
| F8 | should-fix | Refactor không có bước đỏ | Đã sửa B-08: refactor phải làm đỏ bằng mutation |
| F9 | minor | Task bị hủy; so trùng chỉ với payload liền trước | Đã sửa B-13 và TC-SKILL-02 |
| F10 | minor | PR template còn 2 dòng chỉ ghi DBS | Đã sửa A-02 |

**Vòng 4** (reviewer mới, Opus 5.5): reviewer sinh lại cả 48 PR bằng máy. Kết quả: F1, F3–F10 đã sửa, F2 mới sửa một phần. Có thêm 3 phát hiện should-fix, verdict REVISE. Trả lời nguyên văn ở cùng file.

| # | Mức | Phát hiện (tóm tắt) | Xử lý |
|---|---|---|---|
| R4-1 | should-fix | Nhóm docs bị xếp sai: #3 là docs-only; #30 có file `.agents/…mjs`; #28 có 0 file | Đã sửa bằng script: docs gồm #3 và #28, #30 chuyển sang nhóm code |
| R4-2 | should-fix | Câu "người merge cũng phải thỏa" hiểu được theo hai nghĩa | Đã sửa B-10 và BL-160: bấm merge không được tính là review; không giới hạn ai được merge |
| R4-3 | should-fix | Danh sách đường tiền thiếu `common/events/` và `limits.config.ts` | Đã thêm cả hai; #10 lên nhóm tiền, số nhóm thành 22/24/2 |
| — | ghi chú | Tham chiếu ở DBS-76 nên trỏ tới BL-160 | Đã sửa A-09 |

**Vòng 5** (reviewer mới, Opus 5.5): reviewer chạy lại `group-bl160.cjs` trên cả 48 PR, kết quả khớp G2 #1 (22/24/2). R4-1, R4-3 và ghi chú DBS-76 đã sửa xong, R4-2 mới sửa một phần. Có thêm 2 should-fix, verdict REVISE.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| R5-1 | should-fix | A-02 vẫn còn câu cũ về người merge | Đã sửa A-02: dùng đúng câu của B-10 |
| R5-2 | should-fix | #28 không thể thỏa điều kiện đóng | Đã sửa: #28 được miễn, TC-CHORE-04 và M-CHORE-05 bỏ qua nó |

**Vòng 6** (reviewer mới, Opus 5.5): R5-1 và R5-2 đã sửa xong. Không có phát hiện blocking hay should-fix mới. Có 1 minor về câu chữ của M-CHORE-05, đã sửa. **Verdict: APPROVE.**

**Quyết định ở G2 (2026-11-07):** người duyệt trả lời «duyệt», tức là theo mọi đề xuất của agent.
1. Thêm BL-160 với điều kiện đóng chặt như §2.1 câu 1. #28 được miễn. Thêm câu "bấm merge không được tính là review". Việc bật required approvals chỉ ghi làm gợi ý.
2. Xóa roadmap.
3. Xóa `.agents/` và báo ducp8822 trong PR B. **Đã hủy sau G3:** giữ nguyên `.agents/` và `AGENTS.md`.
4. Chọn phương án (Y).
5. Node 24: người duyệt không chọn cài. TC-57-13 lấy bằng chứng từ CI của Draft PR sau G3 (G1 #8).

## 7. Kế hoạch triển khai

PR A làm trên nhánh `chore/CHORE-20261107-repo-audit`. PR B làm trên nhánh `chore/CHORE-20261107-skill`, tách ra từ đầu nhánh A. Môi trường là môi trường đã ghi ở §5.

**Test viết trước của docs.** Với các bước chỉ đổi docs, "test viết trước" là lệnh grep hoặc script so khớp ở §4. Agent chạy lệnh đó trước khi sửa, thấy nó bắt được fact sai, rồi mới sửa. Sau khi sửa, cùng lệnh đó phải ra kết quả rỗng hoặc khớp.

**Script so khớp.** TC-CHORE-04 là `check-backlog.cjs`, đặt cạnh `group-bl160.cjs` trong thư mục screenshots của task để reviewer chạy lại được. Script chỉ đọc, gọi `gh` và không ghi gì lên GitHub.

| Bước | File | Test viết trước | Kết quả đỏ (1 dòng, điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 0 | feature doc này và thư mục screenshots | — | — | `check-doc-links.mjs` | `docs(chore): add CHORE-20261107-repo-audit feature doc` |
| 1 | `backend/tsconfig.build.json` (A-14) | TC-CHORE-01 | | `npx tsc -p tsconfig.build.json --listFilesOnly \| grep -c manual-smoke` cho ra 0, `npm run build` xanh | `build(scripts): exclude manual smoke scripts from dist` |
| 2 | hai file `.gitkeep` (A-15), `env.bootstrap.spec.ts:22` (A-16) | `git ls-files '*.gitkeep'` có 2 dòng; `grep -n "eslint-disable" …:22` không có `--` | | `git ls-files '*.gitkeep'` rỗng, `npm run lint:check` xanh | `chore(repo): drop stale gitkeep files and explain eslint disable` |
| 3 | `README.md`, `docs/README.md`, `backend/README.md`, 4 README trong `backend/src` (A-01, A-03, A-04, A-06) | TC-CHORE-02 (phần README) | | TC-CHORE-02 rỗng với nhóm file này | `docs(readme): match readmes to code on main` |
| 4 | `docs/03_HIGH_LEVEL_ARCHITECTURE.md` (A-05) | TC-CHORE-02 (lệnh `sed` cắt §21), grep `identity/me` trong §7 không thấy | | TC-CHORE-02 rỗng, grep thấy `GET /v1/identity/me` | `docs(architecture): record ADR-14 and built modules in docs/03` |
| 5 | `docs/components/**` (A-07), `threat-model.md` (A-08), `load-tests/README.md` (A-13) | TC-CHORE-02 (phần components và load-tests); grep "Phụ trách: #6" | | TC-CHORE-02 rỗng; grep `Một phần` có ở T1, T10, T11, T12 | `docs(components): sync status lines and threat model with code` |
| 6 | `docs/features/**` (A-09, A-10) | TC-CHORE-03 | | TC-CHORE-03 rỗng, `grep -c $'\x1b'` ở DBS-57 bằng 0 | `docs(features): sync status lines with merged PRs` |
| 7 | `docs/BACKLOG.md` (A-11) và `check-backlog.cjs` | TC-CHORE-04 | | `node docs/features/screenshots/CHORE-20261107-repo-audit/check-backlog.cjs` exit 0; danh sách BL-160 khớp output `group-bl160.cjs` | `docs(backlog): consolidate review gaps into BL-160` |
| 8 | xóa roadmap (A-12); sửa mọi link tới nó | `git grep -n master-roadmap` có kết quả | | `git grep` chỉ còn trong feature doc này, `check-doc-links.mjs` sạch | `docs(roadmap): remove superseded master roadmap` |
| 9 | `CONTRIBUTING.md`, `.github/pull_request_template.md` (A-02, cả dòng §1b của phương án Y) | grep câu "Bấm merge không được tính là review" không thấy; grep `<KIND>-YYYYMMDD` không thấy | | Cả hai grep đều thấy; TC-CHORE-02 rỗng với CONTRIBUTING | `docs(contributing): define review, off-board keys and env exception` |
| 10 | — | — | — | Baseline đủ 6 lệnh (TC-CHORE-05), TC-CHORE-06, chạy M-CHORE-01…06 trên đầu nhánh A | — |
| 11 | `scripts/board.mjs`, `scripts/board.test.mjs`, `scripts/fetch-task.mjs` (B-13) | TC-SKILL-01…04 | | `node --test .claude/skills/dbs-delivering-task/scripts/` xanh; M-SKILL-01 | `feat(skill): detect missing board tabs and unknown dependencies` |
| 12 | `scripts/check-doc-links.mjs`, `scripts/check-doc-links.test.mjs`, `modules/audit/README.md:7` và mọi link mà script mới báo (B-14) | TC-SKILL-05 | | `node --test` xanh; `check-doc-links.mjs` sạch; M-SKILL-04 | `fix(skill): keep underscores in doc link slugs` |
| 13 | RED của M-SKILL-02: 4 subagent đọc skill trên `main` | kịch bản (i)–(iv) | ghi lỗ hổng mà mỗi RED lộ ra | output thô lưu vào `pressure-red.md` | — (ghi cùng bước 14) |
| 14 | `SKILL.md`, `references/{testing,module-notes,platform,task-kinds,team,manual-testing}.md`, `templates/feature-doc.md`, `.claude/skills/README.md` (B-01, B-02, B-05…B-12, B-15, B-17) | TC-SKILL-06 (phần grep `.claude/skills`) | | TC-SKILL-06 rỗng | `docs(skill): close baseline, review and rework gaps` |
| 15 | ~~xóa `.agents/`, viết lại `AGENTS.md`~~ bỏ (quyết định sau G3) | TC-SKILL-06 (`git diff --stat main -- .agents AGENTS.md` rỗng) | | TC-SKILL-06 đạt | — |
| 16 | GREEN của M-SKILL-02 rồi `.claude/skills/README.md` v2.6 (B-16) | 4 subagent mới đọc skill trên nhánh | | output thô lưu vào `pressure-green.md`; cả 4 kịch bản đạt | `docs(skill): bump skill to 2.6 with pressure test results` |
| 17 | — | — | — | Baseline đủ 6 lệnh và `node --test` trên đầu nhánh B. Chạy lại **toàn bộ** §5 trên commit cuối đổi code, SHA ghi ở dòng 1 `manual-test.txt` | — |

Commit nào cũng kết thúc bằng dòng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Rà soát kế hoạch.** Đã đi qua từng giới hạn ghi trong docs và từng DoD của task:
- DoD 1 ứng với bước 3–6 và 9.
- DoD 2 ứng với bước 7. Câu "Lấy số BL kế tiếp" ứng với B-17 ở bước 14.
- DoD 3 ứng với bước 1, 2 và 8.
- DoD 4 ứng với bước 11–16.
- DoD 5 ứng với bảng dán board ở §8, làm ở Phase 5.
- DoD 6 ứng với bước 10 và 17.
- Ba dòng BACKLOG nhắc tới skill hoặc script (dòng 8 phần đầu file, BL-128, BL-136): dòng 8 là cách dùng, không sửa. BL-128 nằm ngoài phạm vi vì phải đổi Dockerfile. BL-136 được thu hẹp ở bước 7.
- Ngoài phạm vi, sẽ có dòng BL mới ở Phase 5:
  - `board.test.mjs` và `check-doc-links.test.mjs` chưa chạy trong CI. Thêm vào CI là đổi CI, thuộc nhóm ngoài phạm vi của G1 #7.
  - TC-57-13 trên Node 24 ở máy local, nếu CI chưa cho bằng chứng trước G4.
- Không có mục nào khác bị bỏ sót.

**Rủi ro và cách lùi:**
- **`exclude` ở bước 1 làm hỏng build hoặc image:** đã grep, không có chỗ nào import `manual-smoke`. Job CI `build` và `docker build` sẽ cho biết. Nếu hỏng thì revert một commit.
- **Docs sửa sai fact:** M-CHORE-04 kiểm lại 6 fact bằng lệnh. Reviewer có thể chạy lại `check-backlog.cjs` và `group-bl160.cjs`.
- **`fetch-task.mjs` báo sai trạng thái:** logic thuần nằm ở `board.mjs` và có test. M-SKILL-01 chạy trên sheet thật. Nếu sai thì revert bước 11, script cũ vẫn chạy được.
- **Bản `.agents/` của Codex lệch thêm sau PR B:** người duyệt đã chấp nhận ở G3 và cho tạm bỏ qua, không ghi dòng BL.
- **PR xếp chồng:** nếu PR A đổi sau review thì rebase B lên A. Sau khi A merge, đổi base của B sang `main`.
- **Trùng số BL với PR đang mở:** kiểm lại `gh pr list --state open` ngay trước bước 7 và trước khi push. Lần kiểm ngày 2026-11-07 cho thấy số lớn nhất đang được dùng là BL-159 (PR #58), nên BL-160 vẫn còn trống. Các dòng BL mới ở Phase 5 lấy số từ BL-161.
- **Xung đột với PR đang mở:** các PR #59, #60, #62 đang sửa đúng những dòng mà bước 7 xóa hoặc gộp vào BL-160:
  - #59: BL-020, BL-144
  - #60: BL-112
  - #62: BL-142, BL-151

  PR nào merge sau sẽ phải giải quyết xung đột ở `docs/BACKLOG.md`. Nếu một trong các PR đó merge trước PR A, mình rebase rồi chạy lại `check-backlog.cjs` và `group-bl160.cjs`. PR mới merge sẽ được thêm vào BL-160 nếu nó cũng không có review.

**Thay đổi sau khi trình G3 (2026-11-07), theo lời người duyệt:**
- **Tổ chức lại `docs/` theo ảnh bảng:** chưa làm. Giữ cấu trúc hiện tại, không có trong task này.
- **Codex:** giữ nguyên. B-03 và B-04 bị bỏ, bước 15 không làm. TC-SKILL-06 kiểm `.agents/` và `AGENTS.md` không đổi. DoD 4 sửa lại cho khớp.
- **Merge `main` vào nhánh:** đã `git fetch`. Nhánh và `origin/main` cùng ở `aeee9c9` (0 commit chênh lệch), nên không có gì để merge và không có conflict.

**Quyết định ở G3 (2026-11-07):** người duyệt trả lời «duyệt g3», tức là theo các đề xuất.
1. Được mở Draft PR A sau bước 10 và Draft PR B (base là nhánh A) sau bước 17. Cả hai giữ Draft cho tới G4.
2. Test của script skill chưa vào CI thì ghi BL-161. Task này không sửa CI.
3. Làm như kế hoạch. Mô tả PR A ghi rõ PR #59, #60 và #62 cần rebase.
4. Bản `.agents/` và `AGENTS.md` lệch so với skill thì tạm bỏ qua, không ghi dòng BL.
