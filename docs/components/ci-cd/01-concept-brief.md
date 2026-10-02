# ci-cd — Concept Brief

> **Status:** Draft · **Owner:** #5 · **Cặp đôi:** #6 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

## Component

| | |
|---|---|
| **Slug** | `ci-cd` |
| **Loại** | Platform · pipeline |
| **Chạy ở** | GitHub Actions |
| **Use case / NFR** | — (NFR-MNT-01, 02) |
| **Sở hữu bảng** | — |
| **Task trong roadmap** | Task 1 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

## Vấn đề

Code merge vào `main` phải tự lên cloud, quay lui được trong vài phút và không lộ bí mật.

## Ý tưởng

- Một image (`backend/Dockerfile`) cho cả `api` và `worker`; tag = commit SHA.
- GitHub Actions kết nối AWS qua OIDC, không lưu access key.
- Migration là bước riêng trước deploy, theo kiểu expand → migrate → contract.
- Rollback = cập nhật service về task definition trước đó.

## Ngoài phạm vi (v1)

- Blue/green phức tạp.
- Deploy lên nhiều môi trường song song.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §13.3 Deploy và rollback.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- Tiếp theo: [`02-architecture.md`](02-architecture.md).
