# ledger — Architecture

> **Status:** Draft (khung rỗng) · **Owner:** #1 · **Cặp đôi:** #4 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

> Viết **trước khi code** (Task 3 trong roadmap). Chưa chép nội dung từ docs/03 sang đây để tránh hai nơi lệch nhau; sau khi nộp P2 sẽ tách phần chi tiết của module này từ docs/03 về file này (xem [docs/README.md](../../README.md)).

## Nguồn hiện tại

- docs/03: §6.1 Luồng chuyển tiền
- docs/03: §7, §7.1 API và mã lỗi
- docs/03: §8 Dữ liệu
- docs/03: §11 Xử lý sự cố
- Interfaces tạm chốt: Task 3 trong [master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md).
- Quy tắc code: [`backend/src/modules/ledger/README.md`](../../../backend/src/modules/ledger/README.md).

## Cần trả lời trong file này

1. **Cấu trúc:** file/thư mục nào, mỗi file chịu trách nhiệm gì.
2. **Dữ liệu:** bảng, ràng buộc, index (nếu có).
3. **Interface công khai:** hàm/API mà module khác hoặc client dùng.
4. **Luồng nội bộ chính:** sơ đồ tuần tự.
5. **Phụ thuộc:** gọi ai, ai gọi mình, đồng bộ hay bất đồng bộ.
6. **Phân quyền** và **lỗi/sự cố** (mã lỗi, hành vi khi dependency hỏng).

## Điểm riêng của component này

- Thứ tự các bước trong một transaction và vì sao đúng thứ tự đó.
- Sync guard: vị trí, cách tính hạn mức ngày theo giờ Việt Nam.
- Job đối soát: kiểm tra gì, chạy khi nào, báo động ra sao.
