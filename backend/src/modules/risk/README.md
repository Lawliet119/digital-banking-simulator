# risk 🟠 Supporting (điểm khác biệt, phần AI) — #4

> **ADR-14 (Accepted):** Giữ rules R1–R6 và tùy chọn API AI bổ sung theo [ADR-14](../../../../docs/adr/0014-fraud-rules-external-ai.md); `rule_only` là mặc định. Fraud runtime hoàn chỉnh chưa được tích hợp.

**Adapter AI độc lập:** `ai/openai-decisions.ts` cung cấp `assess(features, options)`; chưa nối RiskModule, consumer, DB hay API operator và chưa có Dev xác nhận contract. Feature/giới hạn/trạng thái mô tả ở [FRAUD-API-02](../../../../docs/features/FRAUD-API-02-standalone-risk.md); gọi provider thật chỉ với credential an toàn, dữ liệu tổng hợp và quyền/giới hạn phù hợp. Không coi adapter là fraud end-to-end.

DBS-59 thêm `RiskModule`, contract `RiskRule`/`FeatureProvider` và hai lớp provider khung. Sáu luật R1–R6 thuần và `ScoringService` đã được hiện thực; service nhận feature, cấu hình đã chuẩn hóa và assessment có sẵn, không gọi OpenAI hay DB. R3 ([feature doc](../../../../docs/features/DBS-95-r3-new-account-large-transfer.md)) và R6 dùng snapshot; R4/R5 phụ thuộc feature do provider cấp. `OnlineFeatureProvider` (DBS-109, [feature doc](../../../../docs/features/DBS-109-online-feature-provider.md)) cấp đủ `Features`: R1/R5 từ sorted set Redis có khóa phủ (`risk:gen` + `:cov`), dự phòng SQL cho cùng kết quả khi lạnh, event muộn xa hoặc Redis lỗi; R2/R4 và số liệu 24 giờ từ `v_transfer_facts` (mili giây, không Seq Scan). `RuleSetRepository` (DBS-110, [feature doc](../../../../docs/features/DBS-110-rule-set-repository.md)) đọc phiên bản cấu hình luật hiện hành qua `cfg:risk:latest` (TTL 60 giây) và nội dung `cfg:risk:v{n}`; miss hoặc Redis lỗi thì đọc `risk_rule_sets`; `parseRuleSet` chuẩn hóa JSON phẳng của seed thành `ScoringConfig`, khối `ai.*` hỏng chỉ đánh dấu `aiConfigInvalid`. `OfflineFeatureProvider` vẫn ném lỗi chưa cấu hình; cả hai chưa được đăng ký vào DI; consumer, repository cấu hình và API review chưa được nối; bảng `risk_decisions` đã có từ [RSK-01](../../../../docs/features/RSK-01-risk-decisions-migration.md) nhưng chưa có writer (DBS-111). Chưa chứng minh feature window/SQL, dedup, customer isolation hoặc fraud end-to-end.

Phát hiện giao dịch đáng ngờ; nhân viên review và quyết định.

|             |                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------- |
| Use case    | UC-9 chấm điểm · UC-10 review cờ · UC-12 cấu hình luật                                      |
| Chạy ở      | **api** (controller review, cấu hình) **+ worker** (consumer chấm điểm) — module dùng chung |
| Sở hữu bảng | `fraud_flags`, `fraud_rule_hits`, `risk_rule_sets`                                          |

Migration DBS-58 tạo ba bảng trên, seed rule set v1 (`mode=rule_only`) và cặp trigger append-only cho `risk_rule_sets`. Contract JSON seed và bảng test nằm tại [feature doc](../../../../docs/features/DBS-58-fraud-migration.md). Tính năng scoring/consumer và API review là task tiếp theo; migration không khởi động worker.
| Thiết kế | `docs/03` §15 |

## Phải giữ

- **Hệ thống chỉ gắn cờ, không tự khóa tài khoản.** Khách hàng không bao giờ thấy cờ.
- `rule_only` là mặc định; khi được bật qua gate ADR-14, API AI chỉ bổ sung điểm ở worker, lỗi thì dùng kết quả luật và không ảnh hưởng giao dịch đã hoàn tất.
- **Luật là hàm thuần** `evaluate(event, features, params)`: không gọi Redis hay DB. Đặc trưng đến từ `FeatureProvider` (online: Redis + SQL; offline: dữ liệu trong bộ nhớ) để cùng một code luật chạy được cả trên hệ thống thật lẫn script đánh giá.
- Mọi cửa sổ thời gian tính theo `occurredAt` của sự kiện, không theo giờ worker.
- R3, R6 dùng **ảnh chụp** trong sự kiện (`fromBalanceBefore`, `fromAccountCreatedAt`), không đọc trạng thái hiện tại.
- Consumer idempotent: ghi `processed_events` cùng transaction với cờ; khóa chính `fraud_flags(transfer_id)` chặn cờ trùng.
- **Consumer chỉ khởi động khi `runsWorkers()`** — instance `api` không bao giờ poll queue.
- Worker chạy bằng DB role `dbs_worker`: đọc giao dịch qua view `v_transfer_facts` (không đọc thẳng bảng `transfers`); chỉ ghi `fraud_flags`, `fraud_rule_hits`, `processed_events`, `audit_log` (database-design §8).

## Export công khai (`index.ts`)

Hầu như không có: module khác không gọi `risk`. Giao tiếp qua sự kiện (queue `risk-events`).
