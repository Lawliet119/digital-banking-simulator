# notification ⚪ Generic — #3

Nhận sự kiện, gửi thông báo. v1 chỉ ghi log (giả lập), chưa gửi email thật.

| | |
|---|---|
| Chạy ở | **`worker`** |
| Sở hữu bảng | `notification_log` |
| Queue | `notification-events` (+ DLQ) |

## Phải giữ

- Lỗi ở đây **không bao giờ** ảnh hưởng chuyển tiền: bất đồng bộ, retry có backoff, circuit breaker.
- Không nêu lý do gian lận trong thông báo khóa tài khoản (BR-13).

DBS-96 tạo `notification_log` với identity bigint, FK user nullable (ON DELETE RESTRICT),
CHECK hai kind và index event_id không unique. Một sự kiện có thể có nhiều người nhận.
Writer tương lai phải dùng thông báo chung và test BR-13; COMMENT trong schema không kiểm
được ngữ nghĩa văn bản. Revert migration xóa lịch sử notification; chỉ chạy trên DB tạm
hoặc sau khi operator đã quyết định bảo toàn dữ liệu. Consumer và retention job chưa thuộc DBS-96.
- Consumer idempotent như mọi consumer khác.
