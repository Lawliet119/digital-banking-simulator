# notification — Concept Brief

> **Status:** Draft · **Owner:** #3 · **Cặp đôi:** #2 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

## Component

| | |
|---|---|
| **Slug** | `notification` |
| **Loại** | ⚪ Generic · module backend |
| **Chạy ở** | `worker` |
| **Use case / NFR** | — (FR-NOT-01) |
| **Sở hữu bảng** | `notification_log` |
| **Task trong roadmap** | Task 5 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

## Vấn đề

Khách cần biết giao dịch và thay đổi trạng thái tài khoản, nhưng thông báo lỗi không được ảnh hưởng chuyển tiền.

## Ý tưởng

- Consumer của queue `notification-events`, chạy ở role `worker`.
- Bất đồng bộ hoàn toàn: retry có backoff và circuit breaker; lỗi ở đây không bao giờ ảnh hưởng chuyển tiền.
- Thông báo khóa tài khoản **không** nêu lý do gian lận (BR-13).

## Ngoài phạm vi (v1)

- Gửi SMS hoặc email thật.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §10 Bất đồng bộ: outbox và event; §11 Xử lý sự cố.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- Quy tắc code và những điều phải giữ: [`backend/src/modules/notification/README.md`](../../../backend/src/modules/notification/README.md).
- Tiếp theo: [`02-architecture.md`](02-architecture.md).
