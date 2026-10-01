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
- Consumer idempotent như mọi consumer khác.
