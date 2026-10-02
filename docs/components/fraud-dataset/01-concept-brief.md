# fraud-dataset — Concept Brief

> **Status:** Draft · **Owner:** #6 · **Cặp đôi:** #4 (người dùng dữ liệu) · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

## Component

| | |
|---|---|
| **Slug** | `fraud-dataset` |
| **Loại** | Quality · bộ dữ liệu đánh giá |
| **Chạy ở** | Script cục bộ |
| **Use case / NFR** | — (NFR-FRD-03) |
| **Sở hữu bảng** | — |
| **Task trong roadmap** | Task 7 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

## Vấn đề

Không có dữ liệu thật; cần dữ liệu có nhãn để đo precision, recall mà người viết luật không tự chấm bài mình.

## Ý tưởng

- Generator do #6 viết; #4 chỉ biết tên và mô tả một câu của từng kịch bản, **không xem code**.
- Chia tập theo khách hàng: ~70% tune, ~30% holdout; nhãn holdout giữ tới tuần 7.
- Có hard negatives (giao dịch hợp lệ trông đáng ngờ) và kịch bản ngoài tầm luật để đo recall trung thực.

## Ngoài phạm vi (v1)

- Dữ liệu thật hoặc dữ liệu công khai (có thể bổ sung sau, cần kiểm tra giấy phép).

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §15.4 Đánh giá.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- `FRAUD_DETECTION_GUIDE.md` §6 (thiết kế bộ dữ liệu và bức tường #4/#6).
- Tiếp theo: [`02-architecture.md`](02-architecture.md).
