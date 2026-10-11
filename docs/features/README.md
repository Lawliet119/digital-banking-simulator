# Tài liệu từng task (feature docs)

> **Status:** Active · **Owner:** cả nhóm · **Cập nhật:** 2026-10-12

Mỗi task implement trên board (tính năng, sửa lỗi, hạ tầng, test) có **một file** ở đây: `DBS-<n>-<slug>.md`. File được viết trước khi code và hoàn tất khi bàn giao, theo skill [`dbs-delivering-task`](../../.claude/skills/dbs-delivering-task/SKILL.md) và mẫu [`feature-doc.md`](../../.claude/skills/dbs-delivering-task/templates/feature-doc.md).

| Mục | Nội dung | Viết ở phase |
|---|---|---|
| 1. Bối cảnh | Task, DoD chép từ board, phụ thuộc, phạm vi | 1 (duyệt ở G1) |
| 2. Kiến trúc | Vị trí, interface, dữ liệu, transaction, sơ đồ | 2 |
| 3. Hành vi | Quy tắc, ví dụ API, `errorCode`, ca biên | 3 |
| 4. Test cases | `TC-<n>-NN`, truy vết DoD/AC | 3 (duyệt ở G2) |
| 5. Domain review | Phát hiện của AI reviewer và cách xử lý | 3 |
| 6. Kế hoạch | Các bước, test viết trước, lệnh chứng minh | 4 (duyệt ở G3) |
| 7. Kết quả | Lệnh kiểm tra, đối chiếu test case, ảnh chụp | 5 (duyệt ở G4) |
| 8. Tài liệu đã cập nhật | File docs khác đã sửa | 5 |

**Ảnh chụp** tính năng sau khi implement nằm ở `screenshots/DBS-<n>/NN-mo-ta.png` và được nhúng vào mục 7 của file tương ứng.

Lỗi không có mã trên board dùng tên `BUG-YYYYMMDD-<slug>.md`.

## Danh sách

| Task | Tóm tắt | Vai | Trạng thái |
|---|---|---|---|
| _chưa có_ | | | |
