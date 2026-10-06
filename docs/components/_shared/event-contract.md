# Event contract

> **Status:** Proposed — chờ #3 chốt · **Owner:** #3 · **Cặp đôi:** #1, #4 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-06

> Nguồn duy nhất cho hình dạng sự kiện sau khi chốt. Bản JSON ở docs/03 §10 đã khớp bảng dưới (2026-10-06); khi tách docs/03 (sau P2) mục đó sẽ trỏ về đây.
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
| `sameOwner` | boolean | ngoại lệ cho R5, R6 | Hai tài khoản cùng một khách hàng (FRAUD_DETECTION_GUIDE §5.2) |
| `fromUserId`, `toUserId` | uuid | `notification` biết gửi cho ai | Chủ của hai tài khoản tại thời điểm giao dịch (database-design §13, điểm 14) |

## `AccountStatusChanged`

Có chung bốn trường đầu (`eventId`, `eventType`, `occurredAt`, `correlationId`) với `TransferCompleted`.

| Trường | Kiểu | Dùng cho | Ghi chú |
|---|---|---|---|
| `accountId` | uuid | nội dung thông báo | |
| `ownerUserId` | uuid | `notification` biết gửi cho ai | Chủ tài khoản (`users.id`) |
| `newStatus` | `ACTIVE` \| `LOCKED` | nội dung thông báo | |
| `changedByUserId` | uuid | truy vết chéo với audit | Nhân viên thực hiện |

Không mang lý do khóa: lý do nằm ở `audit_log`, và thông báo cho khách không bao giờ nêu lý do gian lận (BR-13).

## `TransferRejected` (chưa phát ở v1)

Luồng REJECTED ở docs/03 §6.1 không ghi outbox. Có phát hay không do #1 và #3 chốt ở Gate 1 của task ledger. Nếu bật, payload như sau (cùng bốn trường đầu như trên):

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `transferId` | uuid | |
| `fromAccountId` | uuid | |
| `reason` | `RejectReason` | `ACCOUNT_NOT_ACTIVE`, `LIMIT_PER_TX_EXCEEDED`, `LIMIT_PER_DAY_EXCEEDED`, `INSUFFICIENT_FUNDS` |

## Không phát ở v1

`FraudFlagRaised` và `FraudFlagReviewed` (docs/02 §9) là khái niệm miền. Cờ và kết luận đã được lưu ở `fraud_flags` và `audit_log`; thêm sự kiện khi có bên tiêu thụ.

## Bảng định tuyến

| Event | Phát ra khi | Gửi tới queue |
|---|---|---|
| `TransferCompleted` | Nạp tiền hoặc chuyển tiền hoàn tất | `risk-events`, `notification-events` |
| `TransferRejected` | Lệnh bị từ chối | `risk-events` (tùy chọn, **chưa phát ở v1**) |
| `AccountStatusChanged` | Khóa / mở khóa tài khoản | `notification-events` |

## Quy tắc

- Consumer **không** đọc trạng thái hiện tại để thay snapshot (số dư, tuổi tài khoản đã đổi khi consumer chạy).
- Giao hàng at-least-once, không đảm bảo thứ tự; consumer idempotent theo `eventId`.
- Message sai schema đi thẳng DLQ, không retry.
