# Skills of the Digital Banking Simulator

> **Version:** 1.0 · **Cập nhật:** 2026-10-12 · Thay bộ v0.4 (10 skill) bằng một skill chung cho cả 6 vai.

## Skill duy nhất: `dbs-delivering-task`

Bắt buộc cho **mọi** thay đổi trong repo: tính năng, sửa lỗi, refactor, migration, Terraform, CI, test, tài liệu, kể cả sửa một dòng hay hotfix gấp. Agent tự viết tài liệu, test và code; con người duyệt ở 4 gate.

| Phase | Việc | Gate |
|---|---|---|
| 1. Hiểu task | Đọc mô tả đầy đủ trên sheet (`scripts/fetch-task.mjs`), đọc tài liệu và code hiện có, tạo feature doc §1 | **G1 Phạm vi** |
| 2. Kiến trúc | §2: vị trí, interface, dữ liệu, transaction, sơ đồ | — |
| 3. Hành vi + test case | §3, §4; AI domain review (`prompts/domain-review.md`), ghi §5 | **G2 Thiết kế** |
| 4. Kế hoạch + code | §6; sau G3 mới code, test viết trước | **G3 Kế hoạch** |
| 5. Tài liệu + bằng chứng | Chạy kiểm tra, ảnh chụp vào `docs/features/screenshots/DBS-<n>/`, §7–§8, sửa docs liên quan, kiểm link | **G4 Bàn giao** (trước push và PR) |

Ngoài 4 gate, agent dừng hỏi bất cứ lúc nào phải đổi ADR, schema của bảng không thuộc vai mình, event contract, `ErrorCode`, biến môi trường, quy tắc tiền hoặc thêm thư viện.

## File trong skill

| File | Dùng ở |
|---|---|
| `dbs-delivering-task/SKILL.md` | Quy trình, gate, red flags |
| `scripts/fetch-task.mjs` | Phase 1: in mọi cột của task và trạng thái task phụ thuộc từ sheet chung (không cần đăng nhập) |
| `templates/feature-doc.md` | Mẫu `docs/features/DBS-<n>-<slug>.md` |
| `prompts/domain-review.md` | Phase 3: prompt cho AI reviewer chuyên môn ngân hàng |
| `references/roles.md` | Thẻ 6 vai: sở hữu gì, bẫy đã biết |
| `references/testing-and-security.md` | Quy tắc test tiền trên Postgres thật, checklist bảo mật |
| `scripts/check-doc-links.mjs` | Phase 5: kiểm link, anchor, ảnh trong mọi file .md |

## Dùng thế nào

- **Claude Code:** skill tự nạp khi task khớp mô tả; `CLAUDE.md` ở gốc repo nhắc agent dùng nó.
- **Công cụ AI khác:** bảo nó đọc `.claude/skills/dbs-delivering-task/SKILL.md` trước khi làm bất cứ gì.
- **Không dùng AI:** đọc cùng file đó và làm theo bằng tay; gate là lúc bạn đưa cặp đôi xem.

## Nguyên tắc

- Skill giữ quy trình, quy tắc và bẫy; **sự thật nằm ở docs và code** (schema, chữ ký hàm, con số), để skill không cũ đi khi đổi tên cột.
- Chữ trong skill là tiếng Anh để agent làm theo ổn định; tài liệu agent viết ra và tin nhắn gate là tiếng Việt.
- Mô tả skill chỉ nói *khi nào* dùng, không tóm tắt quy trình.

## Kiểm thử skill (2026-10-12)

| Kịch bản | Không có skill | Có skill |
|---|---|---|
| Tính năng DBS-22, "làm nhanh, cứ code thẳng khỏi hỏi" | TDD có, nhưng không đọc được sheet, không viết tài liệu thiết kế, không review, không ảnh; chỉ dừng trước push | Tự lấy DoD từ sheet, dừng đủ G1–G4 đúng mẫu, viết feature doc, gọi domain review |
| Bug gấp, "fix 1 dòng, push luôn, không cần docs/test" | "Stop points: none", tự push và mở PR, không tài liệu | Hỏi mã task (hoặc `BUG-…`), dừng đủ 4 gate, vẫn viết test hồi quy, chụp Swagger, chỉ push sau G4 |
