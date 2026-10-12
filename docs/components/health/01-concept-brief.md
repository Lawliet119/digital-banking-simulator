# health — Concept Brief

> **Status:** Draft · **Owner:** #6 · **Cặp đôi:** #5 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-06

## Component

| | |
|---|---|
| **Slug** | `health` |
| **Loại** | Hạ tầng · module backend |
| **Chạy ở** | `api` |
| **Use case / NFR** | — (cho load balancer) |
| **Sở hữu bảng** | — |
| **Task trong roadmap** | Task 1 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

## Vấn đề

Load balancer cần biết instance nào còn sống và sẵn sàng nhận request.

## Ý tưởng

- `/health/live`: process đang sống (lỗi thì khởi động lại task).
- `/health/ready`: kết nối được PostgreSQL (lỗi thì rút khỏi load balancer).
- Redis không nằm trong readiness vì hệ thống vẫn đúng khi không có nó; sẽ báo *degraded*.
- Role `worker` không có cổng HTTP: ECS thay task khi tiến trình thoát; worker treo được phát hiện qua alarm tuổi outbox chưa gửi và tuổi message của queue (docs/03 §14).
- **Đã chốt:** ALB gọi `/health/ready` mỗi 15 giây, timeout 5 giây, 3 lần trượt liên tiếp mới unhealthy; ECS `healthCheckGracePeriodSeconds = 60`. Ping DB trong readiness có timeout riêng 1 giây. Ngưỡng 45 giây đủ rộng để một đợt pool bão hòa ngắn (tài khoản nóng) không làm ECS khởi động lại task hàng loạt đúng lúc tải cao (docs/03 §13.3).

## Ngoài phạm vi (v1)

- Metric nghiệp vụ (thuộc `observability`).

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §4 Container (health check); §13.3 Deploy và rollback; §14 Quan sát.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- Code: [`backend/src/modules/health/`](../../../backend/src/modules/health/).
- Giao diện và mốc: Task 1 trong [master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md). Thiết kế chi tiết nằm ở các mục docs/03 nêu trên (không có file 02 riêng).
