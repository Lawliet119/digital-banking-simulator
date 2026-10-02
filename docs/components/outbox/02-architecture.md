# outbox — Architecture

> **Status:** Draft (khung rỗng) · **Owner:** #3 · **Cặp đôi:** #2 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

> Viết **trước khi code** (Task 4 trong roadmap). Chưa chép nội dung từ docs/03 sang đây để tránh hai nơi lệch nhau; sau khi nộp P2 sẽ tách phần chi tiết của module này từ docs/03 về file này (xem [docs/README.md](../../README.md)).

## Nguồn hiện tại

- docs/03: §10 Bất đồng bộ: outbox và event
- docs/03: §11 Xử lý sự cố
- Interfaces tạm chốt: Task 4 trong [master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md).
- Quy tắc code: [`backend/src/modules/outbox/README.md`](../../../backend/src/modules/outbox/README.md).

## Cần trả lời trong file này

1. **Cấu trúc:** file/thư mục nào, mỗi file chịu trách nhiệm gì.
2. **Dữ liệu:** bảng, ràng buộc, index (nếu có).
3. **Interface công khai:** hàm/API mà module khác hoặc client dùng.
4. **Luồng nội bộ chính:** sơ đồ tuần tự.
5. **Phụ thuộc:** gọi ai, ai gọi mình, đồng bộ hay bất đồng bộ.
6. **Phân quyền** và **lỗi/sự cố** (mã lỗi, hành vi khi dependency hỏng).

## Điểm riêng của component này

- Bảng định tuyến và danh sách event (xem `_shared/event-contract.md`).
- Chu kỳ poll, kích thước lô, dọn outbox sau 7 ngày.
- Retry, visibility timeout, ngưỡng chuyển DLQ (5 lần).
