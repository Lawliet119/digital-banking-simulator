# platform-infra — Concept Brief

> **Status:** Draft · **Owner:** #5 · **Cặp đôi:** #6 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

## Component

| | |
|---|---|
| **Slug** | `platform-infra` |
| **Loại** | Platform · hạ tầng AWS (Terraform) |
| **Chạy ở** | AWS |
| **Use case / NFR** | — (NFR-AVL, REC, SEC, COST) |
| **Sở hữu bảng** | — |
| **Task trong roadmap** | Task 1, Task 9 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

## Vấn đề

Cần hạ tầng dựng lại được bằng code, an toàn, chi phí kiểm soát được trong ngân sách credit.

## Ý tưởng

- Terraform chia `bootstrap` (state S3), `modules/` và `envs/dev|prod`.
- Phần giữ lại gần như miễn phí (S3 state, ECR, VPC, Cognito) tách khỏi phần dựng/xóa hằng ngày (RDS, ElastiCache, ALB, WAF, ECS).
- Dev: Single-AZ, 1 task. Production: Multi-AZ, ≥ 2 task, chỉ bật khi demo HA và đo SLO.
- Chưa tạo NAT Gateway khi chưa chốt ADR-10.

## Ngoài phạm vi (v1)

- Kubernetes/EKS (ADR-06).
- Multi-region.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §13 Triển khai (baseline AWS); §12 Bảo mật; §13.2 Chi phí.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- Quy tắc code và những điều phải giữ: [`infra/terraform/README.md`](../../../infra/terraform/README.md).
- Tiếp theo: [`02-architecture.md`](02-architecture.md).
