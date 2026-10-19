# Tài liệu từng task (feature docs)

> **Status:** Active · **Owner:** cả nhóm · **Cập nhật:** 2026-10-19

Mỗi task implement trên board (tính năng, sửa lỗi, hạ tầng, test) có **một file** ở đây: `DBS-<n>-<slug>.md`. File được viết trước khi code và hoàn tất khi bàn giao, theo skill [`dbs-delivering-task`](../../.claude/skills/dbs-delivering-task/SKILL.md) và mẫu [`feature-doc.md`](../../.claude/skills/dbs-delivering-task/templates/feature-doc.md).

| Mục | Nội dung | Viết ở phase |
|---|---|---|
| 1. Bối cảnh | Task, DoD chép từ board, phụ thuộc, phạm vi | 1 (duyệt ở G1) |
| 2. Hành vi | Quy tắc, ví dụ API, `errorCode`, ca biên | 2 |
| 3. Kiến trúc | Vị trí, interface, dữ liệu, transaction, sơ đồ | 2 |
| 4. Test cases tự động | `TC-<n>-NN`, truy vết DoD/AC | 2 |
| 5. Test thủ công | Kịch bản chạy tay bằng ứng dụng thật (`M-<n>-NN`) | 2 (duyệt ở G2) |
| 6. Domain review | Phát hiện của AI reviewer và cách xử lý | 2 |
| 7. Kế hoạch | Các bước, test viết trước, lệnh chứng minh | 3 (duyệt ở G3) |
| 8. Kết quả | Lệnh kiểm tra, đối chiếu test case, kết quả test thủ công, ảnh chụp, bàn giao | 4–5 (duyệt ở G4) |
| 9. Tài liệu đã cập nhật | File docs khác đã sửa | 5 |

Feature doc làm bằng mẫu 8 mục cũ (kiến trúc ở §2, hành vi ở §3, ví dụ DBS-20 khi được merge) giữ nguyên, không cần sửa lại.

**Ảnh chụp** tính năng sau khi implement nằm ở `screenshots/DBS-<n>/NN-mo-ta.png` và được nhúng vào mục 8 của file tương ứng.

Lỗi không có mã trên board dùng tên `BUG-YYYYMMDD-<slug>.md`.

## Danh sách

| Task | Tóm tắt | Vai | Trạng thái |
|---|---|---|---|
| [DBS-20](DBS-20-migration-users-customers-accounts.md) | Migration 1: users, customers, accounts và tài khoản SYSTEM funding | #1 Ledger | Implemented |
| [DBS-21](DBS-21-migration-transfers-ledger-idempotency.md) | Migration 2: transfers, ledger_entries, idempotency_keys, view v_transfer_facts | Dev | Implemented |
| [DBS-22](DBS-22-common-money-type-dto-validator.md) | @common/money: `Money`, `Balance`, `@IsMoneyAmount`, JSON an toàn cho bigint | Dev | Implemented |
| [DBS-35](DBS-35-ci-github-actions.md) | GitHub Actions CI: sáu job song song (lint, typecheck, unit, e2e, db, build) trên mỗi PR và push `main` | Dev | Plan approved |
