# risk 🟠 Supporting (điểm khác biệt, phần AI) — #4

> **Đề xuất ADR-14 (Proposed):** Phương án rules + API AI được đề xuất ở [ADR-14](../../../../docs/adr/0014-fraud-rules-external-ai.md) và mô tả ở [FRAUD-API-01](../../../../docs/features/FRAUD-API-01-external-ai-decision.md); chưa được nhóm chấp nhận, chưa triển khai. Nội dung dưới đây vẫn là thiết kế Accepted.

Phát hiện giao dịch đáng ngờ; nhân viên review và quyết định.

| | |
|---|---|
| Use case | UC-9 chấm điểm · UC-10 review cờ · UC-12 cấu hình luật |
| Chạy ở | **api** (controller review, cấu hình) **+ worker** (consumer chấm điểm) — module dùng chung |
| Sở hữu bảng | `fraud_flags`, `fraud_rule_hits`, `risk_rule_sets` |

Migration DBS-58 tạo ba bảng trên, seed rule set v1 (`mode=rule_only`) và cặp trigger append-only cho `risk_rule_sets`. Contract JSON seed và bảng test nằm tại [feature doc](../../../../docs/features/DBS-58-fraud-migration.md). Tính năng scoring/consumer và API review là task tiếp theo; migration không khởi động worker.
| Thiết kế | `docs/03` §15 |

## Phải giữ

- **Hệ thống chỉ gắn cờ, không tự khóa tài khoản.** Khách hàng không bao giờ thấy cờ.
- Mô hình ML (chế độ `v3`, chỉ khi qua cổng go/no-go của ADR-08) chỉ chạy ở worker, không đổi schema, lỗi thì rơi về 6 luật; không bao giờ là điều kiện để giao dịch hoàn tất.
- **Luật là hàm thuần** `evaluate(event, features, params)`: không gọi Redis hay DB. Đặc trưng đến từ `FeatureProvider` (online: Redis + SQL; offline: dữ liệu trong bộ nhớ) để cùng một code luật chạy được cả trên hệ thống thật lẫn script đánh giá.
- Mọi cửa sổ thời gian tính theo `occurredAt` của sự kiện, không theo giờ worker.
- R3, R6 dùng **ảnh chụp** trong sự kiện (`fromBalanceBefore`, `fromAccountCreatedAt`), không đọc trạng thái hiện tại.
- Consumer idempotent: ghi `processed_events` cùng transaction với cờ; khóa chính `fraud_flags(transfer_id)` chặn cờ trùng.
- **Consumer chỉ khởi động khi `runsWorkers()`** — instance `api` không bao giờ poll queue.
- Worker chạy bằng DB role `dbs_worker`: đọc giao dịch qua view `v_transfer_facts` (không đọc thẳng bảng `transfers`); chỉ ghi `fraud_flags`, `fraud_rule_hits`, `processed_events`, `audit_log` (database-design §8).

## Export công khai (`index.ts`)

Hầu như không có: module khác không gọi `risk`. Giao tiếp qua sự kiện (queue `risk-events`).
