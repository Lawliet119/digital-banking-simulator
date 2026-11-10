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
- Mỗi dòng `notification_log` mang `correlation_id` của event (DBS-134, migration
  `1793750400000`): cùng một mã nối audit, `outbox_events`, message SQS và thông báo. Cột cho phép
  NULL cho dòng cũ hoặc do worker bản cũ ghi lúc deploy; `down` bỏ cột, không xóa thông báo.

## Đã triển khai

`NotificationConsumer` kế thừa `ConsumerBase` (`@common/messaging`, DBS-101): khung lo long polling chỉ ở worker, kiểm sự kiện bằng `validateEvent`, ghi `(notification, eventId)` vào `processed_events` cùng transaction với hiệu ứng, và đưa vào DLQ ngay ở lần nhận đầu mọi message sai schema hoặc loại sự kiện lạ (body không phải JSON cũng vậy). Lỗi tạm thời được giao lại, và ở lần nhận thứ 5 message vào DLQ. Class này chỉ nói một sự kiện ghi gì (DBS-102, `noticesFor`): chuyển tiền giữa hai chủ → một dòng cho người gửi và một cho người nhận (cùng chủ thì một dòng), nạp tiền → chủ tài khoản đích, đổi trạng thái → chủ tài khoản. Câu chữ là câu cố định chọn từ loại sự kiện và trạng thái, không số tiền, không lý do khóa (BR-13). Sự kiện nhận lần hai chỉ được xác nhận, không thông báo lại. Lỗi tạm thời được ẩn 5, 10, 20, 40 giây (backoff của `ConsumerBase`) trước khi giao lại. URL DLQ lấy theo quy ước `<url queue>-dlq`. Chưa có circuit breaker: v1 chưa gọi dịch vụ ngoài.

**Audit của thông báo (DBS-135, AC-8.2):** `apply` ghi thêm một dòng `audit_log` mỗi event (`notification.sent`, worker, `actor` NULL, `correlationId` của event, target là transfer hoặc account, metadata chỉ `count`) trong cùng transaction với `notification_log` và claim `processed_events`, để kiểm toán viên, chỉ đọc được `audit_log`, thấy bước thông báo trong chuỗi của giao dịch. Audit lỗi thì cả transaction rollback và message được giao lại (tối đa 5 lần rồi DLQ). Không ghi câu chữ hay lý do (BR-13).
