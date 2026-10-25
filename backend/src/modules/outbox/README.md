# outbox — hạ tầng sự kiện — #3

Đưa sự kiện từ bảng `outbox_events` ra các queue, ít nhất một lần.

> **Status:** Draft · **Owner:** Dev · **Verified against code:** schema outbox/processed và partial indexes; writer/relay/consumer chưa triển khai.

Hai bảng có migration và test PostgreSQL thật. `published_at` được UPDATE khi relay gửi xong, các bảng cho phép cleanup DELETE; không gắn trigger append-only. `processed_events` chống trùng theo cặp consumer/event, không phải khóa ngoại của outbox. `down` chỉ chạy trong transaction READ COMMITTED, khóa cả hai bảng rồi từ chối nếu còn dữ liệu. Hành vi phát/gửi/xử lý sự kiện vẫn chờ các task runtime.

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
