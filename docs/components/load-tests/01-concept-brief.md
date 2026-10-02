# load-tests — Concept Brief

> **Status:** Draft · **Owner:** #6 · **Cặp đôi:** #5 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

## Component

| | |
|---|---|
| **Slug** | `load-tests` |
| **Loại** | Quality · load test và chaos |
| **Chạy ở** | k6 |
| **Use case / NFR** | — (NFR-PERF, SCAL) |
| **Sở hữu bảng** | — |
| **Task trong roadmap** | Task 8 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

## Vấn đề

Mọi cam kết về hiệu năng và tính đúng phải có số đo, không chỉ lời nói.

## Ý tưởng

- Các kịch bản: baseline (12 → 60 → 120 RPS), tài khoản nóng, request trùng song song, stress, rate limit.
- Sau mỗi lần chạy kiểm tra bất biến: tổng Nợ = tổng Có, tổng số dư = 0, không tài khoản khách nào âm.
- Chạy từ một máy cùng region, không từ laptop qua mạng nhà.

## Ngoài phạm vi (v1)

- Load test sản phẩm production thật.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §17 Demo bắt buộc; (docs/02 §5) Phân tích workload.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- Quy tắc code và những điều phải giữ: [`load-tests/README.md`](../../../load-tests/README.md).
- Tiếp theo: [`02-architecture.md`](02-architecture.md).
