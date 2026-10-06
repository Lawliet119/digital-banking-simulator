# health — Concept Brief

> **Status:** Draft · **Owner:** #5 · **Cặp đôi:** #6 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-06

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
- Role `worker` không có cổng HTTP nên ECS dùng health check bằng lệnh riêng.
- **Cần chốt (#5):** ECS thay task trượt health check của ALB. Nếu ALB gọi `/health/ready` và pool kết nối bão hòa vì tài khoản nóng, ping DB có thể timeout và ECS khởi động lại nhiều task đúng lúc tải cao. (Khi mọi target đều unhealthy, ALB vẫn gửi traffic cho tất cả, nên đây không phải sập toàn bộ mà là vòng khởi động lại.) Cân nhắc: ngưỡng unhealthy rộng + `healthCheckGracePeriodSeconds`, hoặc ALB gọi `/health/live` và chỉ dùng `/health/ready` khi deploy.

## Ngoài phạm vi (v1)

- Metric nghiệp vụ (thuộc `observability`).

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §4 Container (health check); §13.3 Deploy và rollback; §14 Quan sát.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- Code: [`backend/src/modules/health/`](../../../backend/src/modules/health/).
- Tiếp theo: [`02-architecture.md`](02-architecture.md).
