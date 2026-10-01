# risk 🟠 Supporting (điểm khác biệt, phần AI) — #4

Phát hiện giao dịch đáng ngờ; nhân viên review và quyết định.

| | |
|---|---|
| Use case | UC-9 chấm điểm · UC-10 review cờ · UC-12 cấu hình luật |
| Chạy ở | **api** (controller review, cấu hình) **+ worker** (consumer chấm điểm) — module dùng chung |
| Sở hữu bảng | `fraud_flags`, `fraud_rule_hits`, `risk_rule_sets` |
| Thiết kế | `docs/03` §15 |

## Phải giữ

- **Hệ thống chỉ gắn cờ, không tự khóa tài khoản.** Khách hàng không bao giờ thấy cờ.
- **Luật là hàm thuần** `evaluate(event, features, params)`: không gọi Redis hay DB. Đặc trưng đến từ `FeatureProvider` (online: Redis + SQL; offline: dữ liệu trong bộ nhớ) để cùng một code luật chạy được cả trên hệ thống thật lẫn script đánh giá.
- Mọi cửa sổ thời gian tính theo `occurredAt` của sự kiện, không theo giờ worker.
- R3, R6 dùng **ảnh chụp** trong sự kiện (`fromBalanceBefore`, `fromAccountCreatedAt`), không đọc trạng thái hiện tại.
- Consumer idempotent: ghi `processed_events` cùng transaction với cờ; khóa chính `fraud_flags(transfer_id)` chặn cờ trùng.
- **Consumer chỉ khởi động khi `runsWorkers()`** — instance `api` không bao giờ poll queue.
- DB role riêng cho worker: chỉ đọc `transfers`; chỉ ghi `fraud_flags`, `fraud_rule_hits`, `processed_events`, `audit_log`.

## Export công khai (`index.ts`)

Hầu như không có: module khác không gọi `risk`. Giao tiếp qua sự kiện (queue `risk-events`).
