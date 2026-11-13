# ci-cd — Concept Brief

> **Status:** Draft · **Owner:** #5 (deploy, quét image); job test trong CI do Dev viết · **Verified against code:** một phần: `ci.yml` sáu job (DBS-35, DBS-41), build và đẩy image lên ECR qua OIDC kèm đọc kết quả scan ECR (DBS-36, `image.yml`), tự deploy ECS (DBS-38, `deploy.yml`), bước migration (DBS-68). cổng quét Trivy (image) và gitleaks (secret) trong `ci.yml` và `image.yml` (DBS-155; chưa có run trên GitHub). Chưa có: chặn deploy theo kết quả scan ECR · **Cập nhật:** 2026-11-12

## Component

| | |
|---|---|
| **Slug** | `ci-cd` |
| **Loại** | Platform · pipeline |
| **Chạy ở** | GitHub Actions |
| **Use case / NFR** | — (NFR-MNT-01, 02) |
| **Sở hữu bảng** | — |
| **Task trong roadmap** | Task 1 của roadmap cũ (đã xóa ngày 2026-11-07); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md) |

## Vấn đề

Code merge vào `main` phải tự lên cloud, quay lui được trong vài phút và không lộ bí mật.

## Ý tưởng

- Job test (có code): [`ci.yml`](../../../.github/workflows/ci.yml) chạy sáu job song song `lint`, `typecheck`, `unit`, `e2e`, `db`, `build` trên mỗi PR và mỗi lần push vào `main`. Tên job là hợp đồng với required status checks của `main`; cách đọc kết quả ở [CONTRIBUTING mục 4b](../../../CONTRIBUTING.md#4b-đọc-kết-quả-ci-trên-github-actions).
- Một image (`backend/Dockerfile`) cho cả `api` và `worker`; tag = commit SHA.
- Cổng quét: job `image-scan` (Trivy: lỗ hổng HIGH/CRITICAL có bản sửa và secret trong image) và `secret-scan` (gitleaks trên lịch sử tới `HEAD`) chạy ở mọi PR; `image.yml` quét lại trước khi lấy credential AWS nên image có lỗ hổng không lên ECR. Ngoại lệ có lý do và hạn xem lại. Kết quả: [scan-results](scan-results.md).
- GitHub Actions kết nối AWS qua OIDC, không lưu access key.
- Migration là bước riêng trước deploy, theo kiểu expand → migrate → contract.
- Rollback = cập nhật service về task definition trước đó.

## Ngoài phạm vi (v1)

- Blue/green phức tạp.
- Deploy lên nhiều môi trường song song.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §13.3 Deploy và rollback.
- Nghiệp vụ, yêu cầu và mô hình miền: [docs/BRD.md](../../BRD.md).
- Giao diện và mốc: Task 1 của roadmap cũ (đã xóa); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md). Thiết kế chi tiết nằm ở các mục docs/03 nêu trên (không có file 02 riêng).
