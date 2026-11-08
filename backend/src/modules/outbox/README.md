# outbox — hạ tầng sự kiện — #3

Đưa sự kiện từ bảng `outbox_events` ra các queue, ít nhất một lần.

> **Status:** Draft · **Owner:** Dev · **Verified against code:** schema, partial indexes, OutboxWriter và relay (PostgreSQL + ElasticMQ thật); consumer của risk chưa có.

Hai bảng có migration và test PostgreSQL thật. `published_at` được UPDATE khi relay gửi xong, các bảng cho phép cleanup DELETE; không gắn trigger append-only. `processed_events` chống trùng theo cặp consumer/event, không phải khóa ngoại của outbox. `down` chỉ chạy trong transaction READ COMMITTED, khóa cả hai bảng rồi từ chối nếu còn dữ liệu. Relay (`OutboxRelayService`, module `OutboxRelayModule`) chạy ở worker: mỗi ≤ 500 ms lấy tối đa 100 dòng chưa gửi bằng `FOR UPDATE SKIP LOCKED`, gửi tới từng queue theo bảng định tuyến (`outbox-routing.ts`), rồi đặt `published_at` trong cùng transaction. Gửi lỗi giữa chừng thì các sự kiện trước đó vẫn được đánh dấu đã gửi, sự kiện lỗi và các sự kiện sau nằm lại hàng đợi; loại sự kiện chưa có route nằm lại (BL-010). Mỗi giờ một job xóa dòng đã gửi và `processed_events` quá 7 ngày. Test: `test/services/outbox-relay.services-spec.ts`.

|             |                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chạy ở      | Writer: **`api` / `worker`**; relay: `worker`                                                                                    |
| Sở hữu bảng | `outbox_events` (mọi module ghi qua `OutboxWriter.add`, trong transaction của mình), `processed_events` (khung chống xử lý trùng cho mọi consumer) |
| Thiết kế    | `docs/03` §10                                                                                                                                      |

## Ghi sự kiện

Import `OutboxModule` vào module producer, inject `OutboxWriter` qua `@modules/outbox` rồi gọi `add(manager, event): Promise<void>` bằng manager của `TransactionService.run`. Manager phải có transaction đang hoạt động. Writer chỉ INSERT, không gọi SQS/Redis/HTTP, không tự commit hoặc retry. Trùng `eventId` bị unique constraint từ chối; writer không upsert.

Input phải qua `assertEvent` của `@common/events`; writer chụp JSON đồng bộ trước await, kiểm lại envelope sẽ lưu và lấy mọi cột từ snapshot này. Payload là toàn event, giữ extension tương thích JSON. Producer sai schema hoặc serialization thất bại làm transaction nghiệp vụ rollback có chủ ý; caller không được nuốt lỗi rồi commit (fail-closed). Tiền luôn là chuỗi, không có số dư trong Redis.

`correlationId` trong input luôn bắt buộc và hợp lệ. Writer đọc context ALS hiện có qua public `PinoLogger.logger.bindings()`: thiếu/null dùng `event.correlationId`; context hợp lệ phải trùng `event.correlationId`; mismatch hoặc context sai bị từ chối trước INSERT. Không tạo ID mới hoặc ghi đè để che lỗi producer. Provider context chung xuyên worker/message vẫn thuộc DBS-43.

**Producer chạy nền (BL-123).** Context này sống theo async context của request: một relay hay consumer được khởi động từ bên trong một request giữ nguyên `correlationId` của request đó, nên mọi event mang id khác bị từ chối `NOT_ALLOWED`. Producer nền phải **tách** bằng `logger.runInContext(callback)` **không truyền `bindings`** (mặc định `inherit: false` tạo store mới từ logger gốc), hoặc ghi event mang đúng id của context. Khởi động từ ngoài mọi request thì không cần tách. Hành vi này được khóa bằng TC-57-15.

**Chuỗi không lưu được.** Trường mở rộng được phép (`allowUnknown`), nhưng PostgreSQL jsonb không lưu được ký tự NUL (U+0000) hay surrogate lẻ (ví dụ `�`), ở giá trị lẫn khóa. Writer từ chối chúng trước INSERT bằng `InvalidEventError` với một issue `{ path: '', code: 'INVALID_FORMAT' }`, thông điệp không chứa giá trị, và cả transaction của caller rollback như mọi lỗi validate khác (TC-57-14). Cặp surrogate hợp lệ (emoji) vẫn được lưu. Giới hạn kích thước payload (jsonb từ chối chuỗi quá 268 435 455 byte) chưa có: BL-123.

`TransferCompleted.occurredAt` do producer lấy từ `transfers.created_at` của DB rồi chuyển `Date#toISOString()`; writer chỉ kiểm/bảo toàn, không chứng minh nguồn thời gian. Relay/giao hàng và producer nghiệp vụ chưa được cung cấp bởi writer. [Hợp đồng sự kiện](../../../../docs/components/_shared/event-contract.md) · [Hồ sơ và bằng chứng DBS-57](../../../../docs/features/DBS-57-outbox-writer.md).

## Phải giữ

- Relay: `SELECT … WHERE published_at IS NULL ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED` → gửi → set `published_at`. Nhiều task không lấy trùng; sự cố giữa chừng thì gửi lại (at-least-once). Một sự kiện gửi lỗi ở lại hàng và **không chặn** các sự kiện sau nó; lỗi không tự khỏi (SQS 4xx trừ 429, queue chưa cấu hình) được gạt trong bộ nhớ 30 s rồi gấp đôi, tối đa 10 phút; ba lỗi tạm thời liên tiếp kết thúc lô; một lô không bắt đầu sự kiện mới sau 15 s, mỗi lần gửi quá 5 s bị bỏ (tổng ≤ 25 s), tắt êm dừng giữa hai sự kiện. Vòng lặp giữ nhịp 500 ms nếu có sự kiện đã gửi, chỉ chờ 5 s khi không gửi được gì vì lỗi tạm thời. Relay là **ngoại lệ duy nhất** của quy tắc "không gọi SQS trong transaction" (chỉ khóa hàng `outbox_events`, gửi lặp vẫn đúng vì at-least-once); dùng timeout riêng, không dùng retry deadlock của `withTransaction`.
- **Mỗi consumer một queue + một DLQ riêng** (`risk-events`, `notification-events`). Relay gửi mỗi sự kiện tới **mọi** queue quan tâm theo bảng định tuyến; một queue chung chỉ giao mỗi message cho một consumer.
- Gửi message **sau** commit, xóa message **sau** khi ghi DB xong.
- Event contract (có ảnh chụp `fromBalanceBefore`, `fromAccountCreatedAt`, `sameOwner`) định nghĩa ở một nơi và dùng chung.
- Consumer idempotent bằng `processed_events(consumer, event_id)` cùng transaction với tác động.
