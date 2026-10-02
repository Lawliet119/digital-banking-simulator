# risk — Architecture

> **Status:** Draft (khung rỗng) · **Owner:** #4 · **Cặp đôi:** #1 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

> Viết **trước khi code** (Task 6 trong roadmap). Chưa chép nội dung từ docs/03 sang đây để tránh hai nơi lệch nhau; sau khi nộp P2 sẽ tách phần chi tiết của module này từ docs/03 về file này (xem [docs/README.md](../../README.md)).

## Nguồn hiện tại

- docs/03: §15 Kiến trúc phát hiện gian lận
- docs/03: §9 Redis (R-3 bộ đếm, R-4 cấu hình)
- docs/03: §10 Outbox và event
- Interfaces tạm chốt: Task 6 trong [master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md).
- Quy tắc code: [`backend/src/modules/risk/README.md`](../../../backend/src/modules/risk/README.md).
- `FRAUD_DETECTION_GUIDE.md` — hướng dẫn chi tiết, sẽ được tách thành 02/03/06 sau khi nộp P2.

## Cần trả lời trong file này

1. **Cấu trúc:** file/thư mục nào, mỗi file chịu trách nhiệm gì.
2. **Dữ liệu:** bảng, ràng buộc, index (nếu có).
3. **Interface công khai:** hàm/API mà module khác hoặc client dùng.
4. **Luồng nội bộ chính:** sơ đồ tuần tự.
5. **Phụ thuộc:** gọi ai, ai gọi mình, đồng bộ hay bất đồng bộ.
6. **Phân quyền** và **lỗi/sự cố** (mã lỗi, hành vi khi dependency hỏng).

## Điểm riêng của component này

- Event nào, snapshot nào mỗi luật dùng (xem `_shared/event-contract.md`).
- Hai FeatureProvider (online/offline) và test so khớp.
- Cách đánh giá và chia tập tune/holdout (xem `FRAUD_DETECTION_GUIDE.md` §6).
