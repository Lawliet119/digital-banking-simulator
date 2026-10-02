# accounts — Architecture

> **Status:** Draft (khung rỗng) · **Owner:** #2 · **Cặp đôi:** #3 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

> Viết **trước khi code** (Task 2 trong roadmap). Chưa chép nội dung từ docs/03 sang đây để tránh hai nơi lệch nhau; sau khi nộp P2 sẽ tách phần chi tiết của module này từ docs/03 về file này (xem [docs/README.md](../../README.md)).

## Nguồn hiện tại

- docs/03: §6.2 Khóa tài khoản và thu hồi phiên
- docs/03: §7 API
- docs/03: §8 Dữ liệu
- Interfaces tạm chốt: Task 2 trong [master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md).
- Quy tắc code: [`backend/src/modules/accounts/README.md`](../../../backend/src/modules/accounts/README.md).

## Cần trả lời trong file này

1. **Cấu trúc:** file/thư mục nào, mỗi file chịu trách nhiệm gì.
2. **Dữ liệu:** bảng, ràng buộc, index (nếu có).
3. **Interface công khai:** hàm/API mà module khác hoặc client dùng.
4. **Luồng nội bộ chính:** sơ đồ tuần tự.
5. **Phụ thuộc:** gọi ai, ai gọi mình, đồng bộ hay bất đồng bộ.
6. **Phân quyền** và **lỗi/sự cố** (mã lỗi, hành vi khi dependency hỏng).

## Điểm riêng của component này

- Cách `lockForUpdate` khóa nhiều tài khoản theo thứ tự id.
- Kiểm tra giới hạn 3 tài khoản trong transaction (khóa hàng `customers`).
- Luồng khóa tài khoản: thứ tự DB → Redis, và khi Redis lỗi.
