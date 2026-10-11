# DBS-<n> · <Tóm tắt task>

> **Status:** Draft → Design approved (G2) → Implemented (G4) · **Vai:** #<n> <tên vai> · **Cặp đôi:** #<n> · **Nhánh:** `<type>/DBS-<n>-<slug>` · **PR:** — · **Cập nhật:** YYYY-MM-DD

## 1. Bối cảnh

- **Task trên board:** tóm tắt, tuần, Deliverable/Demo. **Expect:** chép nguyên văn.
- **DoD:** chép nguyên văn từng gạch đầu dòng của DoD trên board.
- **Phụ thuộc:** từng task kèm trạng thái thật trong repo (không chỉ theo board).
- **Đã có gì:** file code, tài liệu, task trước liên quan (link).
- **Ngoài phạm vi:** những gì task này cố ý không làm.
- **Câu hỏi mở:** đánh số, kèm đề xuất.

## 2. Kiến trúc

- **Vị trí:** module, role (`api` / `worker` / cả hai), file chính.
- **Interface dùng và cung cấp:** chữ ký thật lấy từ code.
- **Dữ liệu:** bảng, cột, index, ràng buộc chạm tới (đối chiếu `database-design.md`).
- **Ranh giới transaction:** những gì nằm trong một `TransactionService.run`; không gọi Redis, HTTP, SQS bên trong.
- **Sơ đồ:** mermaid sequence hoặc flow nếu có từ hai thành phần trở lên.
- **Bug:** nguyên nhân gốc (đã tái hiện) và vì sao cách sửa đúng chỗ.
- **Thay đổi cấp hệ thống:** mục docs/03, `_shared`, ADR cần sửa trong cùng PR, hoặc "không có".

## 3. Hành vi

Mỗi hành vi một mục: điều kiện → kết quả, ví dụ request/response JSON thật, `errorCode` khi lỗi, quy tắc và ca biên (giá trị cụ thể).

## 4. Test cases

| ID | Truy vết (DoD / AC) | Lớp (unit / e2e Postgres thật / load) | Given · When · Then | `errorCode` mong đợi |
|---|---|---|---|---|
| TC-<n>-01 | DoD #1, AC-x.y | e2e | … | … |

Mọi gạch đầu dòng của DoD có ít nhất một test case.

## 5. Domain review (AI)

**Reviewer:** subagent, model …, ngày … · **Kết quả:** N phát hiện (blocking a, should-fix b, minor c).

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | … | đã sửa §3 / không sửa vì … |

## 6. Kế hoạch triển khai

| Bước | File | Test viết trước | Lệnh chứng minh |
|---|---|---|---|
| 1 | … | TC-<n>-01 | `npm run test:e2e -- <file>` |

Rủi ro và cách lùi.

## 7. Kết quả

- **Lệnh kiểm tra** (chạy lúc bàn giao): kết quả có số lượng, dán dạng text.
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-<n>-01 | `test/….e2e-spec.ts` › tên test | đạt / đơn giản hóa (lý do) / chưa làm (lý do) |

- **Ảnh chụp** (`docs/features/screenshots/DBS-<n>/`):

![Mô tả](screenshots/DBS-<n>/01-ten.png)

- **Lệch so với kế hoạch** và việc để lại cho vai khác.

## 8. Tài liệu đã cập nhật

Danh sách file docs khác đã sửa trong PR này, hoặc "không có".
