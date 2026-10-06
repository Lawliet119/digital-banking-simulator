# outbox — hạ tầng sự kiện — #3

Đưa sự kiện từ bảng `outbox_events` ra các queue, ít nhất một lần.

| | |
|---|---|
| Chạy ở | **`worker`** |
| Sở hữu bảng | `outbox_events` (mọi module ghi qua `OutboxWriter.add`, trong transaction của mình), `processed_events` (khung chống xử lý trùng cho mọi consumer) |
| Thiết kế | `docs/03` §10 |

## Phải giữ

- Relay: `SELECT … WHERE published_at IS NULL ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED` → gửi → set `published_at`. Nhiều task không lấy trùng; sự cố giữa chừng thì gửi lại. Relay là **ngoại lệ duy nhất** của quy tắc "không gọi SQS trong transaction" (chỉ khóa hàng `outbox_events`, gửi lặp vẫn đúng vì at-least-once); dùng timeout riêng, không dùng retry deadlock của `withTransaction`.
- **Mỗi consumer một queue + một DLQ riêng** (`risk-events`, `notification-events`). Relay gửi mỗi sự kiện tới **mọi** queue quan tâm theo bảng định tuyến; một queue chung chỉ giao mỗi message cho một consumer.
- Gửi message **sau** commit, xóa message **sau** khi ghi DB xong.
- Event contract (có ảnh chụp `fromBalanceBefore`, `fromAccountCreatedAt`, `sameOwner`) định nghĩa ở một nơi và dùng chung.
- Consumer idempotent bằng `processed_events(consumer, event_id)` cùng transaction với tác động.
