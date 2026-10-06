# outbox — Concept Brief

> **Status:** Draft · **Owner:** #3 · **Cặp đôi:** #2 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-06

## Component

| | |
|---|---|
| **Slug** | `outbox` |
| **Loại** | Hạ tầng sự kiện · module backend |
| **Chạy ở** | `worker` |
| **Use case / NFR** | — (hạ tầng cho UC-9, thông báo) |
| **Sở hữu bảng** | `outbox_events`, `processed_events` (mọi module ghi sự kiện qua `OutboxWriter.add`) |
| **Task trong roadmap** | Task 4 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

## Vấn đề

Sự cố sau commit không được làm mất sự kiện, và ghi sự kiện không được làm chậm hay hỏng giao dịch (D-4, D-5 trong docs/03).

## Ý tưởng

- Sự kiện ghi vào `outbox_events` cùng transaction với nghiệp vụ; relay lấy theo lô bằng `FOR UPDATE SKIP LOCKED` và gửi tới **mọi** queue quan tâm theo bảng định tuyến.
- Mỗi consumer một queue SQS + một DLQ riêng, để lỗi của consumer này không chặn consumer kia.
- Consumer idempotent bằng `processed_events(consumer, event_id)` ghi cùng transaction với tác động.
- Gửi message **sau** commit; xóa message **sau** khi ghi DB xong.

## Ngoài phạm vi (v1)

- SNS fan-out (phương án thay thế, xem ADR-03).
- SQS FIFO, event streaming.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §10 Bất đồng bộ: outbox và event; §11 Xử lý sự cố.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- Quy tắc code và những điều phải giữ: [`backend/src/modules/outbox/README.md`](../../../backend/src/modules/outbox/README.md).
- Tiếp theo: [`02-architecture.md`](02-architecture.md).
