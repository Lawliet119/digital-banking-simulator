# platform-infra — Concept Brief

> **Status:** Draft · **Owner:** #5 · **Verified against code:** một phần: `infra/terraform` có bootstrap state (DBS-31), VPC và ECR (DBS-33), ECS và ALB (DBS-34), Cognito (DBS-54), RDS kèm TLS và secret (DBS-66, DBS-67), Valkey (DBS-75). Chưa có trên `main`: SQS (DBS-73, PR #40 đang mở), dashboard và alarm · **Cập nhật:** 2026-11-07

## Component

| | |
|---|---|
| **Slug** | `platform-infra` |
| **Loại** | Platform · hạ tầng AWS (Terraform) |
| **Chạy ở** | AWS |
| **Use case / NFR** | — (NFR-AVL, REC, SEC, COST) |
| **Sở hữu bảng** | — |
| **Task trong roadmap** | Task 1, Task 9 của roadmap cũ (đã xóa ngày 2026-11-07); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md) |

## Vấn đề

Cần hạ tầng dựng lại được bằng code, an toàn, chi phí kiểm soát được trong ngân sách credit.

## Ý tưởng

- Terraform chia `bootstrap` (state S3), `modules/` và `envs/dev|prod`.
- Phần giữ lại gần như miễn phí (S3 state, ECR, VPC, Cognito) tách khỏi phần dựng/xóa hằng ngày (RDS, ElastiCache, ALB, WAF, ECS).
- Dev: Single-AZ, 1 task. Production: Multi-AZ, ≥ 2 task, chỉ bật khi demo HA và đo SLO.
- Không NAT Gateway: task ECS ở public subnet, security group chỉ nhận từ ALB; RDS và Redis ở private subnet ([ADR-10](../../adr/0010-fargate-egress-public-subnet.md)).
- Region `ap-southeast-1`; tag `project=dbs`, `env`, `owner`; Budget 50/100/150 USD ([ADR-11](../../adr/0011-aws-managed-session-based.md)).

## Ngoài phạm vi (v1)

- Kubernetes/EKS (ADR-06).
- Multi-region.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §13 Triển khai (baseline AWS); §12 Bảo mật; §13.2 Chi phí.
- Nghiệp vụ, yêu cầu và mô hình miền: [docs/BRD.md](../../BRD.md).
- Quy tắc code và những điều phải giữ: [`infra/terraform/README.md`](../../../infra/terraform/README.md).
- Giao diện và mốc: Task 1, Task 9 của roadmap cũ (đã xóa); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md). Thiết kế chi tiết nằm ở các mục docs/03 nêu trên (không có file 02 riêng).
