# notification ⚪ Generic

Nhận sự kiện từ `notification-events`, ghi bảng `notification_log` và log giả lập (v1 chưa gửi email thật).

|             |                                 |
| ----------- | ------------------------------- |
| Chạy ở      | **`worker`** (ghi), `api` (đọc) |
| Sở hữu bảng | `notification_log`              |
| Queue       | `notification-events` (+ DLQ)   |

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

`NotificationConsumer` kế thừa `ConsumerBase` (`@common/messaging`, DBS-101): khung lo long polling chỉ ở worker, kiểm sự kiện bằng `validateEvent`, ghi `(notification, eventId)` vào `processed_events` cùng transaction với hiệu ứng, và đưa vào DLQ ngay ở lần nhận đầu mọi message sai schema hoặc loại sự kiện lạ (body không phải JSON cũng vậy). Lỗi tạm thời được giao lại, và ở lần nhận thứ 5 message vào DLQ. Class này chỉ nói một sự kiện ghi gì (DBS-102, `noticesFor`): chuyển tiền giữa hai chủ → một dòng cho người gửi và một cho người nhận (cùng chủ thì một dòng), nạp tiền → chủ tài khoản đích, đổi trạng thái → chủ tài khoản. Câu chữ là câu cố định chọn từ loại sự kiện và trạng thái, không số tiền, không lý do khóa (BR-13). Sự kiện nhận lần hai chỉ được xác nhận, không thông báo lại. Lỗi tạm thời được ẩn 10, 20, 40, 80 giây (backoff của `ConsumerBase`, BL-210) trước khi giao lại. Mỗi dòng `notification_log` mang `occurred_at` = `event.occurredAt` (BL-211): delivery không có thứ tự, nên mọi reader sắp theo `occurred_at, id`, không theo `id` hay `created_at`. URL DLQ lấy theo quy ước `<url queue>-dlq`. Chưa có circuit breaker: v1 chưa gọi dịch vụ ngoài.

**Audit của thông báo (DBS-135, AC-8.2):** `apply` ghi thêm một dòng `audit_log` mỗi event (`notification.sent`, worker, `actor` NULL, `correlationId` của event, target là transfer hoặc account, metadata chỉ `count`) trong cùng transaction với `notification_log` và claim `processed_events`, để kiểm toán viên, chỉ đọc được `audit_log`, thấy bước thông báo trong chuỗi của giao dịch. Audit lỗi thì cả transaction rollback và message được giao lại (tối đa 5 lần rồi DLQ). Không ghi câu chữ hay lý do (BR-13).

## Đọc thông báo

`NotificationHttpModule` (vai trò `customer`, đăng ký ở `apiModules`); consumer vẫn chỉ ở `NotificationModule` của worker.

- `GET /v1/notifications?limit=&cursor=&filter=all|in|out|account`: thông báo của chính người gọi, mới nhất trước theo `occurred_at, id` (BL-211). Cursor gắn với `filter`. Trả thêm `unreadCount`, và cho mỗi dòng `read`, `accountNumber`, `transfer`.
- `transfer`: consumer chỉ lưu id (`transfer_id`, `account_id`, `counterparty_account_id`, `direction`); số tiền và số dư sau đọc từ sổ cái qua `LedgerLineReader`, tên và số bên kia qua `AccountHolderReader`. Nạp tiền không lộ tài khoản `funding`. Dòng ghi trước migration `1795000015000` có `transfer = null`.
- `POST /v1/notifications/read` `{upToId}`: đánh dấu từ thông báo đó trở về cũ hơn. Quyền ghi duy nhất của api trên bảng là `UPDATE (read_at)`.
- Câu chữ (`message`) vẫn là câu cố định, không số tiền, không lý do khóa (BR-13). Không ghi audit: khách đọc dữ liệu của chính mình.
- Test: `test/db/notifications-read.db-spec.ts`, `test/db/notification-detail.db-spec.ts`, `test/db/db-roles.db-spec.ts`.
