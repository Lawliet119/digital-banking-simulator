# observability — Concept Brief

> **Status:** Draft · **Owner:** #6 · **Cặp đôi:** #5 (cùng #2) · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

## Component

| | |
|---|---|
| **Slug** | `observability` |
| **Loại** | Platform · quan sát |
| **Chạy ở** | CloudWatch (hoặc Grafana) |
| **Use case / NFR** | — (NFR-OBS-01, 02) |
| **Sở hữu bảng** | — |
| **Task trong roadmap** | Task 8 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

## Vấn đề

Cần biết hệ thống khỏe hay không và truy vết một giao dịch xuyên API → outbox → consumer → audit.

## Ý tưởng

- Log JSON có `correlationId` ở mọi dòng.
- SLI: tỉ lệ chuyển tiền thành công, latency p95/p99, thời gian tới cờ, DLQ, kết quả đối soát, Redis fallback.
- Dashboard và alarm cho các SLI trên; SLO chính thức chốt ở P4.

## Ngoài phạm vi (v1)

- Tracing phân tán đầy đủ.
- APM thương mại.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §14 Quan sát và SLI/SLO.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- Tiếp theo: [`02-architecture.md`](02-architecture.md).
