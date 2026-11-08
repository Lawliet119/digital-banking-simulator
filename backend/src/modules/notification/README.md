# notification ⚪ Generic

Nhận sự kiện từ `notification-events`, ghi bảng `notification_log` và log giả lập (v1 chưa gửi email thật).

|             |                               |
| ----------- | ----------------------------- |
| Chạy ở      | **`worker`**                  |
| Sở hữu bảng | `notification_log`            |
| Queue       | `notification-events` (+ DLQ) |

## Phải giữ

- Lỗi ở đây **không bao giờ** ảnh hưởng chuyển tiền: bất đồng bộ, retry có backoff, circuit breaker.
- Không nêu lý do gian lận trong thông báo khóa tài khoản (BR-13).

DBS-96 tạo `notification_log` với identity bigint, FK user nullable (ON DELETE RESTRICT),
CHECK hai kind và index event_id không unique. Một sự kiện có thể có nhiều người nhận.
Writer dùng thông báo chung và kiểm BR-13; COMMENT trong schema không kiểm
được ngữ nghĩa văn bản. Migration `down` khóa bảng `ACCESS EXCLUSIVE` ở `READ COMMITTED` và từ chối (`55000`) nếu bảng đã có dữ liệu.
- Consumer idempotent như mọi consumer khác.

## Đã triển khai

`NotificationConsumer` đọc `notification-events` bằng long polling, kiểm sự kiện bằng `validateEvent`, ghi `(notification, eventId)` vào `processed_events` và ghi bản ghi thông báo chung vào `notification_log` trong cùng transaction, sau đó ghi một dòng log JSON (chỉ id, loại sự kiện, `correlationId`). Sự kiện nhận lần hai chỉ được xác nhận, không thông báo lại. Sự kiện sai dạng không được xác nhận nên SQS giao lại và đưa vào DLQ sau 5 lần; body không phải JSON vào DLQ ngay. URL DLQ lấy theo quy ước `<url queue>-dlq`. Chưa có retry có backoff riêng và circuit breaker: v1 chưa gọi dịch vụ ngoài.
