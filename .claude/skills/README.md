# Skills của Digital Banking Simulator

> **Version:** 2.3 · **Cập nhật:** 2026-10-12 · Skill cho vai Dev (4 software developer, làm theo kiểu kéo); #4 Fraud và #5 Platform & Ops dùng chung phase và gate, quy tắc riêng nằm ở `references/`.

## Skill duy nhất: `dbs-delivering-task`

Bắt buộc cho **mọi** thay đổi trong repo, kể cả sửa một dòng hay hotfix gấp. Mỗi task đi đủ **lên kế hoạch → implement → test → test thủ công**. Agent tự viết tài liệu, test và code; con người duyệt ở 4 gate.

| Phase | Việc | Gate |
|---|---|---|
| 1. Hiểu task | Đọc mô tả đầy đủ trên sheet (`scripts/fetch-task.mjs`), tài liệu và code hiện có, chạy baseline, tạo feature doc §1 | **G1 Phạm vi** |
| 2. Thiết kế | §2 hành vi, §3 kiến trúc, §4 test case tự động, §5 kịch bản test thủ công; AI domain review ghi §6 | **G2 Thiết kế** |
| 3. Kế hoạch | §7: từng bước, test viết trước, lệnh chứng minh | **G3 Kế hoạch** |
| 4. Implement và test | 4a code theo TDD · 4b chạy test tự động, đối chiếu case · 4c **test thủ công** theo §5, ghi kết quả thật | — |
| 5. Tài liệu và bàn giao | Ảnh chụp và `manual-test.txt` từ test thủ công vào `docs/features/screenshots/DBS-<n>/`, §8–§9, sửa docs liên quan, kiểm link | **G4 Bàn giao** (PR chỉ Ready sau G4; không push trước G3, sau G3 chỉ Draft PR khi người duyệt yêu cầu) |

Ngoài 4 gate, agent dừng hỏi bất cứ lúc nào phải đổi ADR, schema của bảng không thuộc vai mình, event contract, `ErrorCode`, biến môi trường, quy tắc tiền, thêm thư viện hoặc rời khỏi kế hoạch §7 đã duyệt.

## File trong skill

| File | Dùng ở |
|---|---|
| `dbs-delivering-task/SKILL.md` | Quy trình, gate, red flags |
| `templates/feature-doc.md` | Mẫu `docs/features/DBS-<n>-<slug>.md` (9 mục) |
| `prompts/domain-review.md` | Phase 2: prompt cho AI reviewer chuyên môn ngân hàng |
| `references/team.md` | Đội ngũ, vai trò, ai sở hữu module nào, ai review ai |
| `references/module-notes.md` | Bẫy đã biết theo module: ledger, identity/accounts, async/audit, foundation, migration |
| `references/testing.md` | Quy tắc test tự động trên Postgres thật, kỹ thuật không dùng sleep, checklist bảo mật |
| `references/manual-testing.md` | Cách chạy test thủ công: quy tắc, môi trường, công cụ, giữ output thô, ảnh chụp |
| `references/task-kinds.md` | Phase thay đổi thế nào theo loại task: bug, migration, thư viện, hạ tầng, vận hành, chỉ sửa docs; khi bước test thủ công cần thứ chưa được build |
| `references/docs-style.md` | Phase 5: văn phong tài liệu (trạng thái hiện tại, mermaid phải render, link) |
| `references/fraud.md`, `references/platform.md` | Quy tắc riêng của #4 Fraud và #5 Platform & Ops |
| `scripts/fetch-task.mjs` | Phase 1: `DBS-n` in mọi cột của task và trạng thái task phụ thuộc; `--next` (thêm Fraud hoặc Ops nếu cần) liệt kê backlog (chưa ai nhận, phụ thuộc đã Done, theo thứ tự board) |
| `scripts/check-doc-links.mjs` | Phase 5: kiểm link, anchor, ảnh trong mọi file .md |

## Dùng thế nào

- **Claude Code:** mở trong thư mục repo; gõ `/dbs-delivering-task DBS-<n>`. `CLAUDE.md` ở gốc cũng buộc agent dùng skill khi bạn chỉ nhắn "làm task DBS-n".
- **Công cụ AI khác:** bảo nó đọc `.claude/skills/dbs-delivering-task/SKILL.md` trước khi làm.
- **Không dùng AI:** đọc cùng file và làm theo bằng tay; gate là lúc bạn đưa một Dev khác xem.

## Nguyên tắc

- Skill giữ quy trình, quy tắc và bẫy; **sự thật nằm ở docs và code** (schema, chữ ký hàm, con số), để skill không cũ đi khi đổi tên cột.
- Chữ trong skill là tiếng Anh để agent làm theo ổn định; tài liệu agent viết ra và tin nhắn gate là tiếng Việt.
- Mô tả skill chỉ nói *khi nào* dùng, không tóm tắt quy trình.

## Lịch sử phiên bản

| Version | Nội dung | Cross-check Opus 5.5 |
|---|---|---|
| 1.0 | Một skill cho 6 vai (5 phase, 4 gate), thẻ 6 vai | kiểm bằng 2 kịch bản áp lực (11/10) |
| 2.0 | Vai mới: 4 developer + Fraud + Platform & Ops. Thêm test thủ công (4c, §5), §8 Bàn giao, mẫu 9 mục, thẻ vai thay bằng `team.md` + `module-notes.md`. Rút kinh nghiệm từ DBS-20 | 2 reviewer Opus 5.5 (quy trình + đi thử trên DBS-79, DBS-76, bug): REVISE, 3 blocking, 12 should-fix |
| 2.1 | Sửa theo cross-check vòng 1: giới hạn "chưa chạy" và log thô; tường fraud trong SKILL và prompt review; xử lý verdict REVISE; gate thoát kế hoạch; `task-kinds.md`; bảng "chưa build"; trạng thái doc theo gate; kiểm phạm vi `git diff` ở G4 | 2 reviewer Opus 5.5 (xác minh 18 phát hiện cũ, đi thử #4, #5, DBS-90, DBS-88, DBS-35): REVISE, 13 sửa đủ, 5 sửa một phần, 1 blocking mới (thư mục dữ liệu fraud) |
| 2.2 | Sửa theo vòng 2: log thô đổi thành `manual-test.txt` (`*.log` bị gitignore), xóa token trước khi commit, không push trước G3, lưu nguyên văn trả lời của reviewer, thư mục tune CSV của fraud ngoài "bức tường", dòng cho logic thuần / CI workflow / Terraform init, `docs-style.md`, checklist G4 trong mẫu | 2 reviewer Opus 5.5 (xác minh vòng 2, đi thử DBS-120, DBS-110, DBS-88 với agent vội và kiểm toán viên thù địch): REVISE, 0 blocking, 5 + 4 should-fix |
| 2.3 | Sửa theo vòng 3: một gate mỗi tin nhắn và chờ trả lời mới sang phase; không đưa gì lên GitHub trước G3 bằng bất kỳ công cụ nào; log thô gắn SHA commit cuối, chạy lại toàn bộ §5 sau mỗi lần sửa code; lệch kế hoạch phải có phê duyệt mới qua G4; cấm `.skip`/`.only`/`.todo`; trạng thái doc theo gate; Terraform red bằng `terraform test` với `mock_provider`; quy tắc nguồn SYSTEM chuyển tiền chính xác hơn | 1 reviewer Opus 5.5 (vòng 4): 16/16 mục sửa đúng; 1 should-fix (tài liệu fraud còn nói theo vai cũ) và 5 minor, đã sửa cùng bản này. Reviewer kết luận không còn blocking |
| 2.4 | Mô hình kéo (12/10) và backlog (`fetch-task.mjs --next`): bỏ chủ module và cặp review cố định; Dev nào thấy task chưa ai nhận thì nhận (`[Nhận: tên]`), làm theo thứ tự board, không chờ ai; review bởi Dev khác bất kỳ; bức tường fraud theo người làm generator | chưa cross-check (chỉ đổi cách phân việc, không đổi phase hay gate) |
