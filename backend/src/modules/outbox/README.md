# outbox — hạ tầng sự kiện — #3

Đưa sự kiện từ bảng `outbox_events` ra các queue, ít nhất một lần.

> **Status:** Draft · **Owner:** Dev · **Verified against code:** schema, partial indexes và OutboxWriter; relay/consumer chưa triển khai.

Hai bảng có migration và test PostgreSQL thật. `published_at` được UPDATE khi relay gửi xong, các bảng cho phép cleanup DELETE; không gắn trigger append-only. `processed_events` chống trùng theo cặp consumer/event, không phải khóa ngoại của outbox. `down` chỉ chạy trong transaction READ COMMITTED, khóa cả hai bảng rồi từ chối nếu còn dữ liệu. Hành vi phát/gửi/xử lý sự kiện vẫn chờ các task runtime.

| | |
|---|---|
| Chạy ở | Writer: **`api` / `worker`**; relay: `worker` (chưa triển khai) |
| Sở hữu bảng | `outbox_events` (mọi module ghi qua `OutboxWriter.add`, trong transaction của mình), `processed_events` (khung chống xử lý trùng cho mọi consumer) |
| Thiết kế | `docs/03` §10 |

## Ghi sự kiện

Import `OutboxModule` vào module producer, inject `OutboxWriter` qua `@modules/outbox` rồi gọi `add(manager, event): Promise<void>` bằng manager của `TransactionService.run`. Manager phải có transaction đang hoạt động. Writer chỉ INSERT, không gọi SQS/Redis/HTTP, không tự commit hoặc retry. Trùng `eventId` bị unique constraint từ chối; writer không upsert.

Input phải qua `assertEvent` của `@common/events`; writer chụp JSON đồng bộ trước await, kiểm lại envelope sẽ lưu và lấy mọi cột từ snapshot này. Payload là toàn event, giữ extension tương thích JSON. Producer sai schema hoặc serialization thất bại làm transaction nghiệp vụ rollback có chủ ý; caller không được nuốt lỗi rồi commit (fail-closed). Tiền luôn là chuỗi, không có số dư trong Redis.

`correlationId` trong input luôn bắt buộc và hợp lệ. Writer đọc context ALS hiện có qua public `PinoLogger.logger.bindings()`: thiếu/null dùng `event.correlationId`; context hợp lệ phải trùng `event.correlationId`; mismatch hoặc context sai bị từ chối trước INSERT. Không tạo ID mới hoặc ghi đè để che lỗi producer. Provider context chung xuyên worker/message vẫn thuộc DBS-43.

`TransferCompleted.occurredAt` do producer lấy từ `transfers.created_at` của DB rồi chuyển `Date#toISOString()`; writer chỉ kiểm/bảo toàn, không chứng minh nguồn thời gian. Relay/giao hàng và producer nghiệp vụ chưa được cung cấp bởi writer. [Hợp đồng sự kiện](../../../../docs/components/_shared/event-contract.md) · [Hồ sơ và bằng chứng DBS-57](../../../../docs/features/DBS-57-outbox-writer.md).

## Phải giữ

- Relay: `SELECT … WHERE published_at IS NULL ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED` → gửi → set `published_at`. Nhiều task không lấy trùng; sự cố giữa chừng thì gửi lại. Relay là **ngoại lệ duy nhất** của quy tắc "không gọi SQS trong transaction" (chỉ khóa hàng `outbox_events`, gửi lặp vẫn đúng vì at-least-once); dùng timeout riêng, không dùng retry deadlock của `withTransaction`.
- **Mỗi consumer một queue + một DLQ riêng** (`risk-events`, `notification-events`). Relay gửi mỗi sự kiện tới **mọi** queue quan tâm theo bảng định tuyến; một queue chung chỉ giao mỗi message cho một consumer.
- Gửi message **sau** commit, xóa message **sau** khi ghi DB xong.
- Event contract (có ảnh chụp `fromBalanceBefore`, `fromAccountCreatedAt`, `sameOwner`) định nghĩa ở một nơi và dùng chung.
- Consumer idempotent bằng `processed_events(consumer, event_id)` cùng transaction với tác động.
