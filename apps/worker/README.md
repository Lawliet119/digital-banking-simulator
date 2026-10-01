# apps/worker

NestJS standalone (không mở port) — xử lý bất đồng bộ.

| Thành phần | Trách nhiệm | Phụ trách |
|---|---|---|
| `outbox-relay` | Đọc `outbox_events` (`FOR UPDATE SKIP LOCKED`), gửi tới từng queue theo bảng định tuyến | #3 |
| `risk-scoring` | Consume `risk-events`, chạy luật R1–R6, ghi `fraud_flags` | #4 |
| `notification` | Consume `notification-events`, gửi thông báo (giả lập bằng log ở v1) | #3 |

Mọi consumer phải idempotent: ghi `processed_events(consumer, event_id)` cùng transaction với tác động. Chi tiết: [docs/03 mục 10](../../docs/03_HIGH_LEVEL_ARCHITECTURE.md).

> Khởi tạo ở tuần 1–2.
