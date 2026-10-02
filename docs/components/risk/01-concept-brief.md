# risk — Concept Brief

> **Status:** Draft · **Owner:** #4 · **Cặp đôi:** #1 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

## Component

| | |
|---|---|
| **Slug** | `risk` |
| **Loại** | 🟠 Supporting · module backend (phần AI/Data) |
| **Chạy ở** | `api` (review, cấu hình) **và** `worker` (chấm điểm) |
| **Use case / NFR** | UC-9, UC-10, UC-12 |
| **Sở hữu bảng** | `fraud_flags`, `fraud_rule_hits`, `risk_rule_sets` |
| **Task trong roadmap** | Task 6 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

## Vấn đề

Giao dịch đáng ngờ chỉ được phát hiện qua báo cáo hôm sau, lúc tiền đã đi xa (P-5 trong docs/01); báo nhầm lại gây hại thật cho khách.

## Ý tưởng

- Sau mỗi giao dịch hoàn tất, worker chấm điểm bằng 6 luật (velocity, số tiền bất thường, tài khoản mới chuyển lớn, chuyển vòng, fan-out, rút cạn) và gắn cờ nếu từ mức Trung bình.
- Luật là hàm thuần, chạy được cả online (Redis + SQL) lẫn offline (dữ liệu trong bộ nhớ) để đánh giá precision/recall.
- Hệ thống chỉ gắn cờ; chỉ nhân viên review và khóa tài khoản. Khách không bao giờ thấy cờ.
- Cấu hình luật có phiên bản bất biến; mỗi cờ ghi phiên bản đã dùng.

## Ngoài phạm vi (v1)

- Machine learning (hướng mở rộng).
- Chặn đồng bộ hoặc giữ tiền chờ duyệt.
- Dữ liệu thiết bị, IP, vị trí.
- Phát hiện phía người nhận (fan-in).

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §15 Kiến trúc phát hiện gian lận; §9 Redis (R-3 bộ đếm, R-4 cấu hình); §10 Outbox và event.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- Quy tắc code và những điều phải giữ: [`backend/src/modules/risk/README.md`](../../../backend/src/modules/risk/README.md).
- `FRAUD_DETECTION_GUIDE.md` — hướng dẫn chi tiết, sẽ được tách thành 02/03/06 sau khi nộp P2.
- Tiếp theo: [`02-architecture.md`](02-architecture.md).
