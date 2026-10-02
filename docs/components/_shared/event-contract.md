# Event contract

> **Status:** Proposed — chờ #3 chốt · **Owner:** #3 · **Cặp đôi:** #1, #4 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

> Nguồn duy nhất cho hình dạng sự kiện sau khi chốt. Hiện docs/03 §10 cũng có bản JSON; khi tách docs/03 (sau P2) mục đó sẽ trỏ về đây.
> Đổi contract đã thống nhất: báo trước cho mọi bên dùng nó và cập nhật file này **trong cùng PR**.

## `TransferCompleted`

| Trường | Kiểu | Dùng cho | Ghi chú |
|---|---|---|---|
| `eventId` | uuid | chống xử lý trùng (`processed_events`) | |
| `eventType` | string | định tuyến | `TransferCompleted` |
| `occurredAt` | ISO-8601 UTC | **mọi cửa sổ thời gian** | Không dùng giờ của worker |
| `correlationId` | uuid | truy vết, audit | Do server sinh |
| `transferId` | uuid | khóa của cờ | |
| `type` | `TRANSFER` \| `DEPOSIT` | risk bỏ qua `DEPOSIT` | |
| `fromAccountId`, `toAccountId` | uuid | R1, R2, R4, R5 | |
| `amount` | string (đồng) | R2, R3, R6 | Không dùng `number` |
| `fromBalanceBefore` | string (đồng) | R6 | **Snapshot** tại thời điểm giao dịch |
| `fromAccountCreatedAt` | ISO-8601 | R3 | **Snapshot** |
| `toAccountCreatedAt` | ISO-8601 | (dự phòng) | Có trong bản docs/03 |
| `sameOwner` | boolean | ngoại lệ cho R5, R6 | **Đề xuất mới** (FRAUD_DETECTION_GUIDE §5.2), chưa có trong docs/03 |

## Bảng định tuyến

| Event | Phát ra khi | Gửi tới queue |
|---|---|---|
| `TransferCompleted` | Nạp tiền hoặc chuyển tiền hoàn tất | `risk-events`, `notification-events` |
| `TransferRejected` | Lệnh bị từ chối | `risk-events` (tùy chọn) |
| `AccountStatusChanged` | Khóa / mở khóa tài khoản | `notification-events` |

## Quy tắc

- Consumer **không** đọc trạng thái hiện tại để thay snapshot (số dư, tuổi tài khoản đã đổi khi consumer chạy).
- Giao hàng at-least-once, không đảm bảo thứ tự; consumer idempotent theo `eventId`.
- Message sai schema đi thẳng DLQ, không retry.
