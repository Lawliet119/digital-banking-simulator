# notification ⚪ Generic

**Chưa có code:** thư mục này mới chỉ có README. Bảng `notification_log` đang được làm ở DBS-96 (PR #50).

Nhận sự kiện, gửi thông báo. v1 chỉ ghi log (giả lập), chưa gửi email thật.

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
Writer tương lai phải dùng thông báo chung và test BR-13; COMMENT trong schema không kiểm
được ngữ nghĩa văn bản. Revert migration xóa lịch sử notification; chỉ chạy trên DB tạm
hoặc sau khi operator đã quyết định bảo toàn dữ liệu. Consumer và retention job chưa thuộc DBS-96.
- Consumer idempotent như mọi consumer khác.

## Đã triển khai

`NotificationConsumer` đọc `notification-events` bằng long polling, kiểm sự kiện bằng `validateEvent`, ghi `(notification, eventId)` vào `processed_events` rồi ghi một dòng log (chỉ id, loại sự kiện, `correlationId`). Sự kiện nhận lần hai chỉ được xác nhận, không thông báo lại. Sự kiện sai dạng không được xác nhận nên SQS giao lại và đưa vào DLQ sau 5 lần; body không phải JSON vào DLQ ngay. URL DLQ lấy theo quy ước `<url queue>-dlq`. Chưa có retry có backoff riêng, circuit breaker và bảng `notification_log`: v1 chưa gửi gì ra ngoài.
